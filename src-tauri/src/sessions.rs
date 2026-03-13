use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Safe string truncation that respects UTF-8 char boundaries
fn safe_truncate(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Safe string truncation from the end (last N bytes)
fn safe_truncate_end(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut start = s.len() - max_bytes;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Get the Claude projects directory
fn claude_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("projects")
}

/// Parse a single JSONL transcript file into structured session data
pub fn parse_transcript(filepath: &str) -> Value {
    let path = PathBuf::from(filepath);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let project = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    let file_size = fs::metadata(filepath)
        .map(|m| m.len())
        .unwrap_or(0);

    let mut session = json!({
        "id": stem,
        "file": filepath,
        "project": project,
        "model": null,
        "version": null,
        "cwd": null,
        "git_branch": null,
        "started_at": null,
        "last_activity": null,
        "status": "idle",
        "messages": [],
        "tools_used": [],
        "agents_spawned": [],
        "current_tool": null,
        "current_thinking": null,
        "message_count": {"user": 0, "assistant": 0},
        "tool_count": 0,
        "file_size": file_size,
    });

    let content = match fs::read_to_string(filepath) {
        Ok(c) => c,
        Err(_) => return session,
    };

    let mut tool_uses: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut last_timestamp: Option<String> = None;
    let mut messages: Vec<Value> = Vec::new();
    let mut tools_used: Vec<Value> = Vec::new();
    let mut agents_spawned: Vec<Value> = Vec::new();
    let mut user_count: u64 = 0;
    let mut assistant_count: u64 = 0;
    let mut tool_count: u64 = 0;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let d: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = d.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let timestamp = d.get("timestamp").and_then(|v| v.as_str()).map(|s| s.to_string());

        // Extract session metadata
        if let Some(ver) = d.get("version").and_then(|v| v.as_str()) {
            if session["version"].is_null() {
                session["version"] = json!(ver);
            }
        }
        if let Some(cwd) = d.get("cwd").and_then(|v| v.as_str()) {
            if session["cwd"].is_null() {
                session["cwd"] = json!(cwd);
            }
        }
        if let Some(branch) = d.get("gitBranch").and_then(|v| v.as_str()) {
            if session["git_branch"].is_null() {
                session["git_branch"] = json!(branch);
            }
        }
        if d.get("sessionId").is_some() && session["started_at"].is_null() {
            if let Some(ref ts) = timestamp {
                session["started_at"] = json!(ts);
            }
        }

        if let Some(ref ts) = timestamp {
            last_timestamp = Some(ts.clone());
        }

        match msg_type {
            "assistant" => {
                assistant_count += 1;
                if let Some(msg) = d.get("message") {
                    if let Some(model) = msg.get("model").and_then(|v| v.as_str()) {
                        if model != "<synthetic>" {
                            session["model"] = json!(model);
                        }
                    }

                    if let Some(content_arr) = msg.get("content").and_then(|v| v.as_array()) {
                        for block in content_arr {
                            let block_type =
                                block.get("type").and_then(|v| v.as_str()).unwrap_or("");

                            match block_type {
                                "thinking" => {
                                    if let Some(thinking) =
                                        block.get("thinking").and_then(|v| v.as_str())
                                    {
                                        if !thinking.is_empty() {
                                            let truncated = safe_truncate_end(thinking, 300);
                                            session["current_thinking"] = json!(truncated);
                                        }
                                    }
                                }
                                "text" => {
                                    if let Some(text) = block.get("text").and_then(|v| v.as_str())
                                    {
                                        if !text.trim().is_empty() {
                                            let truncated = safe_truncate(text, 500);
                                            messages.push(json!({
                                                "role": "assistant",
                                                "text": truncated,
                                                "timestamp": timestamp,
                                            }));
                                        }
                                    }
                                }
                                "tool_use" => {
                                    let tool_name = block
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("?")
                                        .to_string();
                                    let tool_id = block
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let tool_input =
                                        block.get("input").cloned().unwrap_or(json!({}));

                                    tool_count += 1;
                                    session["current_tool"] = json!(&tool_name);
                                    tool_uses.insert(tool_id, tool_name.clone());

                                    let mut tool_entry = json!({
                                        "name": &tool_name,
                                        "timestamp": &timestamp,
                                    });

                                    match tool_name.as_str() {
                                        "Agent" => {
                                            let agent_info = json!({
                                                "description": tool_input.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                                                "subagent_type": tool_input.get("subagent_type").and_then(|v| v.as_str()).unwrap_or("general"),
                                                "model": tool_input.get("model"),
                                                "background": tool_input.get("run_in_background").and_then(|v| v.as_bool()).unwrap_or(false),
                                                "timestamp": &timestamp,
                                            });
                                            agents_spawned.push(agent_info.clone());
                                            tool_entry["agent_info"] = agent_info;
                                        }
                                        "Bash" => {
                                            let cmd = tool_input
                                                .get("command")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");
                                            tool_entry["detail"] = json!(safe_truncate(cmd, 200));
                                        }
                                        "Read" => {
                                            tool_entry["detail"] = json!(tool_input
                                                .get("file_path")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or(""));
                                        }
                                        "Write" => {
                                            let fp = tool_input.get("file_path").and_then(|v| v.as_str()).unwrap_or("");
                                            tool_entry["detail"] = json!(fp);
                                        }
                                        "Edit" => {
                                            let fp = tool_input.get("file_path").and_then(|v| v.as_str()).unwrap_or("");
                                            let old_s = tool_input.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
                                            let new_s = tool_input.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
                                            if !old_s.is_empty() || !new_s.is_empty() {
                                                let old_preview = safe_truncate(old_s.lines().next().unwrap_or(""), 40);
                                                let new_preview = safe_truncate(new_s.lines().next().unwrap_or(""), 40);
                                                tool_entry["detail"] = json!(format!("{}: {} → {}", safe_truncate_end(fp, 30), old_preview, new_preview));
                                            } else {
                                                tool_entry["detail"] = json!(fp);
                                            }
                                        }
                                        "Grep" => {
                                            tool_entry["detail"] = json!(tool_input
                                                .get("pattern")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or(""));
                                        }
                                        "Glob" => {
                                            tool_entry["detail"] = json!(tool_input
                                                .get("pattern")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or(""));
                                        }
                                        "WebFetch" => {
                                            let url = tool_input
                                                .get("url")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");
                                            tool_entry["detail"] = json!(safe_truncate(url, 100));
                                        }
                                        "WebSearch" => {
                                            let q = tool_input
                                                .get("query")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");
                                            tool_entry["detail"] = json!(safe_truncate(q, 150));
                                        }
                                        "Skill" => {
                                            tool_entry["detail"] = json!(tool_input
                                                .get("skill")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or(""));
                                        }
                                        "TodoWrite" => {
                                            if let Some(todos) =
                                                tool_input.get("todos").and_then(|v| v.as_array())
                                            {
                                                let active: Vec<&str> = todos
                                                    .iter()
                                                    .filter(|t| {
                                                        t.get("status")
                                                            .and_then(|v| v.as_str())
                                                            == Some("in_progress")
                                                    })
                                                    .filter_map(|t| {
                                                        t.get("content").and_then(|v| v.as_str())
                                                    })
                                                    .collect();
                                                if let Some(first) = active.first() {
                                                    tool_entry["detail"] = json!(safe_truncate(first, 100));
                                                } else {
                                                    tool_entry["detail"] =
                                                        json!(format!("{} tasks", todos.len()));
                                                }
                                            }
                                        }
                                        _ => {
                                            // Generic fallback
                                            for key in &[
                                                "prompt",
                                                "description",
                                                "query",
                                                "command",
                                                "file_path",
                                                "pattern",
                                                "skill",
                                            ] {
                                                if let Some(val) = tool_input
                                                    .get(*key)
                                                    .and_then(|v| v.as_str())
                                                {
                                                    tool_entry["detail"] = json!(safe_truncate(val, 150));
                                                    break;
                                                }
                                            }
                                        }
                                    }

                                    tools_used.push(tool_entry);
                                }
                                _ => {}
                            }
                        }
                    }

                    let stop = msg.get("stop_reason").and_then(|v| v.as_str());
                    match stop {
                        Some("end_turn") => session["status"] = json!("waiting"),
                        Some("tool_use") => session["status"] = json!("working"),
                        None => session["status"] = json!("streaming"),
                        _ => {}
                    }
                }
            }
            "user" => {
                user_count += 1;
                if let Some(msg) = d.get("message") {
                    if let Some(content_arr) = msg.get("content").and_then(|v| v.as_array()) {
                        for block in content_arr {
                            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                    let truncated = safe_truncate(text, 500);
                                    messages.push(json!({
                                        "role": "user",
                                        "text": truncated,
                                        "timestamp": timestamp,
                                    }));
                                }
                            }
                        }
                    }
                }
            }
            "progress" => {
                session["status"] = json!("working");
            }
            _ => {}
        }
    }

    session["last_activity"] = json!(last_timestamp);
    session["message_count"]["user"] = json!(user_count);
    session["message_count"]["assistant"] = json!(assistant_count);
    session["tool_count"] = json!(tool_count);

    // Detect stale sessions
    if assistant_count == 0 && tool_count == 0 {
        session["status"] = json!("idle");
    }

    // If last activity was >5 min ago and status is working/streaming, mark as waiting
    if let Some(ref ts) = last_timestamp.clone() {
        if let Ok(last_dt) = chrono::DateTime::parse_from_rfc3339(
            &ts.replace("Z", "+00:00"),
        ) {
            let age = chrono::Utc::now()
                .signed_duration_since(last_dt)
                .num_seconds();
            let status = session["status"].as_str().unwrap_or("");
            if age > 300 && (status == "working" || status == "streaming") {
                session["status"] = json!("waiting");
            }
        }
    }

    // Keep only recent items for performance
    let msg_len = messages.len();
    if msg_len > 20 {
        messages = messages[msg_len - 20..].to_vec();
    }
    let tools_len = tools_used.len();
    if tools_len > 50 {
        tools_used = tools_used[tools_len - 50..].to_vec();
    }

    session["messages"] = json!(messages);
    session["tools_used"] = json!(tools_used);
    session["agents_spawned"] = json!(agents_spawned);

    session
}

/// Get all sessions, optionally filtering by active status and max age
pub fn get_all_sessions(active_only: bool, max_age_hours: f64) -> Vec<Value> {
    let claude_projects = claude_dir();
    if !claude_projects.exists() {
        return Vec::new();
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let cutoff = now - (max_age_hours * 3600.0);

    let mut sessions: Vec<(f64, Value)> = Vec::new();

    if let Ok(entries) = fs::read_dir(&claude_projects) {
        for entry in entries.flatten() {
            let project_dir = entry.path();
            if !project_dir.is_dir() {
                continue;
            }

            if let Ok(files) = fs::read_dir(&project_dir) {
                for file_entry in files.flatten() {
                    let file_path = file_entry.path();
                    if file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }

                    let mtime = file_path
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs_f64())
                        .unwrap_or(0.0);

                    if mtime < cutoff {
                        continue;
                    }

                    let filepath_str = file_path.to_str().unwrap_or("");
                    let mut session = parse_transcript(filepath_str);

                    if active_only
                        && session.get("status").and_then(|v| v.as_str()) == Some("idle")
                    {
                        continue;
                    }

                    session["mtime"] = json!(mtime);
                    sessions.push((mtime, session));
                }
            }
        }
    }

    // Sort by mtime descending
    sessions.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    sessions.into_iter().map(|(_, s)| s).collect()
}

/// Get a specific session by ID
pub fn get_session_by_id(session_id: &str) -> Option<Value> {
    let claude_projects = claude_dir();
    if !claude_projects.exists() {
        return None;
    }

    if let Ok(entries) = fs::read_dir(&claude_projects) {
        for entry in entries.flatten() {
            let project_dir = entry.path();
            if !project_dir.is_dir() {
                continue;
            }
            let jsonl_file = project_dir.join(format!("{}.jsonl", session_id));
            if jsonl_file.exists() {
                return Some(parse_transcript(jsonl_file.to_str().unwrap_or("")));
            }
        }
    }

    None
}
