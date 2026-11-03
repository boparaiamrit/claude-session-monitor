//! Incremental parser for Claude Code JSONL transcripts.
//!
//! Each file is read once from the start, then only the bytes appended since the
//! last tick are parsed. Lines are decoded into small typed structs so the bulky
//! parts (tool output, API request blobs, file snapshots) are skipped without
//! being allocated; a day of heavy use can be several hundred MB.

use crate::model::*;
use serde::de::{Deserializer, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

const MAX_TOOLS: usize = 300;
const MAX_MESSAGES: usize = 60;

/// Safe string truncation that respects UTF-8 char boundaries
pub fn safe_truncate(s: &str, max_bytes: usize) -> &str {
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
pub fn safe_truncate_end(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut start = s.len() - max_bytes;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

pub fn parse_ts(ts: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|d| d.timestamp_millis())
}

// ───────────────────────── typed line shapes ─────────────────────────

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Line {
    #[serde(rename = "type")]
    kind: String,
    timestamp: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    version: Option<String>,
    git_branch: Option<String>,
    entrypoint: Option<String>,
    permission_mode: Option<String>,
    is_meta: Option<bool>,
    is_sidechain: Option<bool>,
    effort: Option<Value>,
    ai_title: Option<String>,
    last_prompt: Option<String>,
    request_id: Option<String>,
    message: Option<Msg>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Msg {
    id: Option<String>,
    model: Option<String>,
    stop_reason: Option<String>,
    usage: Option<RawUsage>,
    #[serde(deserialize_with = "content_blocks")]
    content: Vec<Block>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawUsage {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
}

/// One content block. A tool_result's own `content` is not a field here, so serde
/// skips it without allocating.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Block {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
    thinking: Option<String>,
    name: Option<String>,
    id: Option<String>,
    input: Option<Value>,
    tool_use_id: Option<String>,
    is_error: Option<bool>,
}

/// `message.content` is either a plain string or an array of blocks
fn content_blocks<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Block>, D::Error> {
    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = Vec<Block>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("string or array of content blocks")
        }
        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
            Ok(vec![Block {
                kind: "text".into(),
                text: Some(v.to_string()),
                ..Default::default()
            }])
        }
        fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(vec![])
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::new();
            while let Some(b) = seq.next_element::<Block>()? {
                out.push(b);
            }
            Ok(out)
        }
    }
    d.deserialize_any(V)
}

/// What the transcript did last; drives working/waiting detection
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Last {
    #[default]
    Nothing,
    UserPrompt,
    ToolResult,
    AssistantTool,
    AssistantStreaming,
    AssistantEnd,
}

#[derive(Clone, Debug)]
pub struct AgentLaunch {
    pub tool_use_id: String,
    pub agent_type: String,
    pub description: String,
    pub model: Option<String>,
    pub background: bool,
    pub ts: i64,
    pub done: bool,
    pub error: bool,
    pub end_ts: Option<i64>,
}

#[derive(Default)]
pub struct Acc {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub version: Option<String>,
    pub git_branch: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub entrypoint: Option<String>,
    pub started_at: Option<i64>,
    pub last_activity: Option<i64>,
    pub last: Last,
    pub last_at: Option<i64>,
    pub current_tool: Option<ToolCall>,
    pub thinking: Option<String>,
    pub last_prompt: Option<String>,
    pub last_text: Option<String>,
    pub counts: Counts,
    pub usage: Usage,
    pub usage_by_model: HashMap<String, Usage>,
    msg_usage: HashMap<String, (String, Usage)>,
    pub context_tokens: u64,
    pub tools: VecDeque<ToolCall>,
    pub open_tools: HashSet<String>,
    pub messages: VecDeque<Message>,
    pub launches: Vec<AgentLaunch>,
    pub files: HashMap<String, FileTouch>,
    pub todos: Vec<Todo>,
    pub minutes: BTreeMap<i64, u32>,
    pub hours: BTreeMap<i64, HourStat>,
}

pub struct Transcript {
    pub path: PathBuf,
    offset: u64,
    pub version: u64,
    pub file_size: u64,
    pub acc: Acc,
}

impl Transcript {
    pub fn new(path: PathBuf) -> Self {
        Transcript {
            path,
            offset: 0,
            version: 0,
            file_size: 0,
            acc: Acc::default(),
        }
    }

    /// Parse whatever was appended since the last call. Returns true if anything changed.
    pub fn update(&mut self) -> bool {
        let size = match std::fs::metadata(&self.path) {
            Ok(m) => m.len(),
            Err(_) => return false,
        };
        if size < self.offset {
            // Rewritten or truncated: start over
            self.offset = 0;
            self.acc = Acc::default();
        }
        if size == self.offset {
            return false;
        }
        let mut f = match File::open(&self.path) {
            Ok(f) => f,
            Err(_) => return false,
        };
        if f.seek(SeekFrom::Start(self.offset)).is_err() {
            return false;
        }
        let mut buf = Vec::with_capacity((size - self.offset) as usize);
        if f.read_to_end(&mut buf).is_err() {
            return false;
        }
        // Only consume complete lines; a partial last line is picked up next tick
        let last_nl = match buf.iter().rposition(|b| *b == b'\n') {
            Some(i) => i,
            None => return false,
        };
        for raw in buf[..=last_nl].split(|b| *b == b'\n') {
            if let Ok(line) = std::str::from_utf8(raw) {
                self.acc.ingest_line(line.trim());
            }
        }
        self.offset += (last_nl + 1) as u64;
        self.file_size = size;
        self.version += 1;
        true
    }
}

impl Acc {
    fn bump_minute(&mut self, ts: i64) {
        *self.minutes.entry(ts / 60_000).or_insert(0) += 1;
        // keep two hours of minute buckets
        let cutoff = ts / 60_000 - 120;
        while let Some((&k, _)) = self.minutes.iter().next() {
            if k < cutoff {
                self.minutes.remove(&k);
            } else {
                break;
            }
        }
    }

    fn hour(&mut self, ts: i64) -> &mut HourStat {
        let h = ts / 3_600_000 * 3_600_000;
        if self.hours.len() > 24 * 8 {
            if let Some((&k, _)) = self.hours.iter().next() {
                self.hours.remove(&k);
            }
        }
        self.hours.entry(h).or_insert_with(|| HourStat {
            hour: h,
            ..Default::default()
        })
    }

    fn touch_file(&mut self, path: &str, write: bool, ts: i64) {
        if path.is_empty() {
            return;
        }
        let norm = path.replace('\\', "/");
        let e = self.files.entry(norm.clone()).or_insert(FileTouch {
            path: norm,
            reads: 0,
            writes: 0,
            last_ts: ts,
        });
        if write {
            e.writes += 1;
        } else {
            e.reads += 1;
        }
        e.last_ts = ts;
    }

    fn push_message(&mut self, role: &str, text: &str, ts: i64) {
        let t = text.trim();
        if t.is_empty() {
            return;
        }
        self.messages.push_back(Message {
            role: role.to_string(),
            text: safe_truncate(t, 1200).to_string(),
            ts,
        });
        while self.messages.len() > MAX_MESSAGES {
            self.messages.pop_front();
        }
    }

    pub fn ingest_line(&mut self, line: &str) {
        if line.is_empty() {
            return;
        }
        // Bookkeeping lines (API request blobs, file snapshots, queue ops) put `type`
        // first; skip them before paying for a parse.
        if let Some(rest) = line.strip_prefix("{\"type\":\"") {
            let t = rest.split('"').next().unwrap_or("");
            if !matches!(t, "ai-title" | "last-prompt" | "assistant" | "user") {
                return;
            }
        }
        if let Ok(l) = serde_json::from_str::<Line>(line) {
            self.ingest(l);
        }
    }

    fn ingest(&mut self, d: Line) {
        match d.kind.as_str() {
            "ai-title" => {
                if let Some(t) = d.ai_title {
                    self.title = Some(t);
                }
                return;
            }
            "last-prompt" => {
                if let Some(t) = d.last_prompt {
                    self.last_prompt = Some(safe_truncate(&t, 400).to_string());
                }
                return;
            }
            "assistant" | "user" | "system" | "attachment" => {}
            _ => return,
        }
        let ts = d.timestamp.as_deref().and_then(parse_ts);
        if self.session_id.is_none() {
            self.session_id = d.session_id.clone();
        }
        if self.cwd.is_none() {
            self.cwd = d.cwd.clone();
        }
        if d.version.is_some() {
            self.version = d.version.clone();
        }
        if let Some(b) = d.git_branch.as_ref().filter(|b| !b.is_empty()) {
            self.git_branch = Some(b.clone());
        }
        if d.entrypoint.is_some() {
            self.entrypoint = d.entrypoint.clone();
        }
        if let Some(ts) = ts {
            if self.started_at.is_none() {
                self.started_at = Some(ts);
            }
            self.last_activity = Some(ts);
        }
        let ts = ts.or(self.last_activity).unwrap_or(0);

        match d.kind.as_str() {
            "assistant" => self.ingest_assistant(d, ts),
            "user" => self.ingest_user(d, ts),
            _ => {}
        }
    }

    fn ingest_assistant(&mut self, d: Line, ts: i64) {
        let sidechain = d.is_sidechain.unwrap_or(false);
        match &d.effort {
            Some(Value::String(e)) => self.effort = Some(e.clone()),
            Some(Value::Object(o)) => {
                if let Some(l) = o.get("level").and_then(|v| v.as_str()) {
                    self.effort = Some(l.to_string());
                }
            }
            _ => {}
        }
        let Some(msg) = d.message else { return };
        let model = msg.model.clone().unwrap_or_default();
        if !model.is_empty() && model != "<synthetic>" {
            self.model = Some(model.clone());
        }

        // Usage: one API message is written as several lines (one per content block)
        // sharing the same message id, so replace rather than add.
        let mid = msg.id.clone().or(d.request_id.clone());
        if let Some(u) = &msg.usage {
            let usage = Usage {
                input: u.input_tokens,
                output: u.output_tokens,
                cache_read: u.cache_read_input_tokens,
                cache_write: u.cache_creation_input_tokens,
            };
            let model_key = if model.is_empty() || model == "<synthetic>" {
                self.model.clone().unwrap_or_else(|| "unknown".into())
            } else {
                model.clone()
            };
            if let Some(id) = &mid {
                if let Some((old_model, old)) = self.msg_usage.remove(id) {
                    self.usage.sub(&old);
                    if let Some(m) = self.usage_by_model.get_mut(&old_model) {
                        m.sub(&old);
                    }
                    let h = self.hour(ts);
                    h.output = h.output.saturating_sub(old.output);
                    h.input = h.input.saturating_sub(old.prompt_tokens());
                } else {
                    self.counts.assistant += 1;
                }
                self.msg_usage.insert(id.clone(), (model_key.clone(), usage.clone()));
            } else {
                self.counts.assistant += 1;
            }
            self.usage.add(&usage);
            self.usage_by_model.entry(model_key).or_default().add(&usage);
            let h = self.hour(ts);
            h.output += usage.output;
            h.input += usage.prompt_tokens();
            if !sidechain {
                self.context_tokens = usage.prompt_tokens() + usage.output;
            }
        }

        let mut saw_tool = false;
        for b in msg.content {
            match b.kind.as_str() {
                "thinking" => {
                    if let Some(t) = b.thinking.as_deref().filter(|t| !t.trim().is_empty()) {
                        self.thinking = Some(safe_truncate_end(t, 600).to_string());
                    }
                }
                "text" => {
                    if let Some(t) = b.text.as_deref().filter(|t| !t.trim().is_empty()) {
                        self.last_text = Some(safe_truncate(t.trim(), 600).to_string());
                        self.push_message("assistant", t, ts);
                    }
                }
                "tool_use" => {
                    saw_tool = true;
                    self.ingest_tool_use(b, ts);
                }
                _ => {}
            }
        }

        self.last = match msg.stop_reason.as_deref() {
            Some("end_turn") | Some("stop_sequence") | Some("max_tokens") | Some("refusal") => {
                Last::AssistantEnd
            }
            Some("tool_use") => Last::AssistantTool,
            _ if saw_tool => Last::AssistantTool,
            _ => Last::AssistantStreaming,
        };
        self.last_at = Some(ts);
    }

    fn ingest_tool_use(&mut self, b: Block, ts: i64) {
        let name = b.name.unwrap_or_else(|| "?".into());
        let id = b.id.unwrap_or_default();
        let input = b.input.unwrap_or(Value::Null);
        let (detail, file, write) = tool_detail(&name, &input);
        let get = |k: &str| input.get(k).and_then(|v| v.as_str()).map(String::from);

        if name == "Agent" || name == "Task" {
            self.launches.push(AgentLaunch {
                tool_use_id: id.clone(),
                agent_type: get("subagent_type").unwrap_or_else(|| "general-purpose".into()),
                description: get("description").unwrap_or_default(),
                model: get("model"),
                background: input
                    .get("run_in_background")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                ts,
                done: false,
                error: false,
                end_ts: None,
            });
        }
        if name == "TodoWrite" {
            if let Some(todos) = input.get("todos").and_then(|v| v.as_array()) {
                self.todos = todos
                    .iter()
                    .map(|t| Todo {
                        content: t.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        status: t.get("status").and_then(|v| v.as_str()).unwrap_or("pending").to_string(),
                    })
                    .collect();
            }
        }
        if let Some(f) = &file {
            self.touch_file(f, write, ts);
        }

        let call = ToolCall {
            id: id.clone(),
            name,
            detail,
            ts,
            end_ts: None,
            ok: None,
            file,
        };
        self.current_tool = Some(call.clone());
        self.counts.tools += 1;
        self.bump_minute(ts);
        self.hour(ts).tools += 1;
        if !id.is_empty() {
            self.open_tools.insert(id);
        }
        self.tools.push_back(call);
        while self.tools.len() > MAX_TOOLS {
            self.tools.pop_front();
        }
    }

    fn ingest_user(&mut self, d: Line, ts: i64) {
        if d.permission_mode.is_some() {
            self.permission_mode = d.permission_mode.clone();
        }
        let meta = d.is_meta.unwrap_or(false);
        let Some(msg) = d.message else { return };
        for b in msg.content {
            match b.kind.as_str() {
                "text" => {
                    if !meta {
                        if let Some(t) = b.text.as_deref() {
                            self.user_text(t, ts);
                        }
                    }
                }
                "tool_result" => {
                    let id = b.tool_use_id.as_deref().unwrap_or("");
                    self.tool_result(id, b.is_error.unwrap_or(false), ts);
                }
                _ => {}
            }
        }
    }

    fn user_text(&mut self, t: &str, ts: i64) {
        let t = t.trim();
        if t.is_empty() {
            return;
        }
        let shown = if t.starts_with("<command-name>") {
            // "<command-name>/model</command-name> ... <command-args>opus</command-args>"
            let name = between(t, "<command-name>", "</command-name>").unwrap_or("");
            let args = between(t, "<command-args>", "</command-args>").unwrap_or("");
            format!("{} {}", name, args).trim().to_string()
        } else if t.starts_with('<') {
            // system reminders, task notifications, command output
            return;
        } else {
            t.to_string()
        };
        if shown.is_empty() {
            return;
        }
        self.counts.user += 1;
        self.push_message("user", &shown, ts);
        self.last = Last::UserPrompt;
        self.last_at = Some(ts);
    }

    fn tool_result(&mut self, id: &str, err: bool, ts: i64) {
        if id.is_empty() {
            return;
        }
        self.open_tools.remove(id);
        if let Some(t) = self.tools.iter_mut().rev().find(|t| t.id == id) {
            t.end_ts = Some(ts);
            t.ok = Some(!err);
        }
        if let Some(c) = self.current_tool.as_mut() {
            if c.id == id {
                c.end_ts = Some(ts);
                c.ok = Some(!err);
            }
        }
        if let Some(l) = self.launches.iter_mut().find(|l| l.tool_use_id == id) {
            // Background agents return immediately; their own transcript says when they finish
            if !l.background || err {
                l.done = true;
                l.error = err;
                l.end_ts = Some(ts);
            }
        }
        if err {
            self.counts.errors += 1;
            self.hour(ts).errors += 1;
        }
        self.last = Last::ToolResult;
        self.last_at = Some(ts);
    }

    /// Tool calls per minute for the 60 minutes ending at `now_ms`
    pub fn activity(&self, now_ms: i64) -> Vec<u32> {
        let now_min = now_ms / 60_000;
        (0..60)
            .map(|i| *self.minutes.get(&(now_min - 59 + i)).unwrap_or(&0))
            .collect()
    }
}

fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let i = s.find(a)? + a.len();
    let j = s[i..].find(b)? + i;
    Some(&s[i..j])
}

/// Human-readable summary of a tool call: (detail, file path, is_write)
pub fn tool_detail(name: &str, input: &Value) -> (String, Option<String>, bool) {
    let get = |k: &str| input.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let short = |v: &str, n: usize| safe_truncate(v, n).to_string();
    match name {
        "Agent" | "Task" => (short(get("description"), 160), None, false),
        "Bash" | "PowerShell" => {
            let cmd = get("command");
            let desc = get("description");
            let d = if !desc.is_empty() && cmd.len() > 80 {
                desc
            } else {
                cmd
            };
            (short(d.lines().next().unwrap_or(""), 200), None, false)
        }
        "Read" | "NotebookRead" => {
            let fp = get("file_path");
            (fp.to_string(), Some(fp.to_string()), false)
        }
        "Write" | "NotebookEdit" => {
            let fp = if get("file_path").is_empty() {
                get("notebook_path")
            } else {
                get("file_path")
            };
            (fp.to_string(), Some(fp.to_string()), true)
        }
        "Edit" | "MultiEdit" => {
            let fp = get("file_path");
            let old_s = get("old_string");
            let new_s = get("new_string");
            let d = if !old_s.is_empty() || !new_s.is_empty() {
                let o = safe_truncate(old_s.lines().next().unwrap_or("").trim(), 40);
                let n = safe_truncate(new_s.lines().next().unwrap_or("").trim(), 40);
                format!("{}: {} → {}", fp, o, n)
            } else {
                fp.to_string()
            };
            (d, Some(fp.to_string()), true)
        }
        "Grep" | "Glob" => (short(get("pattern"), 160), None, false),
        "WebFetch" => (short(get("url"), 160), None, false),
        "WebSearch" => (short(get("query"), 160), None, false),
        "Skill" => (get("skill").to_string(), None, false),
        "TodoWrite" => {
            let todos = input.get("todos").and_then(|v| v.as_array());
            let active = todos.and_then(|t| {
                t.iter()
                    .find(|x| x.get("status").and_then(|v| v.as_str()) == Some("in_progress"))
                    .and_then(|x| x.get("content").and_then(|v| v.as_str()))
            });
            match (active, todos) {
                (Some(a), _) => (short(a, 140), None, false),
                (None, Some(t)) => (format!("{} tasks", t.len()), None, false),
                _ => (String::new(), None, false),
            }
        }
        _ => {
            for key in [
                "description", "prompt", "query", "command", "file_path", "pattern", "skill", "url",
                "message", "name",
            ] {
                let v = get(key);
                if !v.is_empty() {
                    return (short(v.lines().next().unwrap_or(""), 160), None, false);
                }
            }
            (String::new(), None, false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_counted_once_per_message_and_results_matched() {
        let mut a = Acc::default();
        let lines = [
            r#"{"type":"user","timestamp":"2026-11-03T10:00:00Z","sessionId":"s1","cwd":"C:/p","message":{"role":"user","content":"Fix the bug"}}"#,
            // One API message written as two lines (tool_use, then text) sharing id + usage
            r#"{"type":"assistant","timestamp":"2026-11-03T10:00:01Z","message":{"id":"m1","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20},"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"C:/p/a.ts","old_string":"x","new_string":"y"}}]}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-03T10:00:01Z","message":{"id":"m1","model":"claude-opus-5-5","stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":7,"cache_read_input_tokens":100,"cache_creation_input_tokens":20},"content":[{"type":"text","text":"Editing"}]}}"#,
            r#"{"type":"user","timestamp":"2026-11-03T10:00:03Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"boom"}]}}"#,
            r#"{"type":"ai-title","aiTitle":"Fix the bug","sessionId":"s1"}"#,
            r#"{"type":"api-request-blob","sessionId":"s1","hash":"h","message":{"huge":"skipped"}}"#,
        ];
        for l in lines {
            a.ingest_line(l);
        }
        assert_eq!(a.counts.assistant, 1, "two lines of one message count once");
        assert_eq!(a.usage.output, 7, "later usage replaces earlier for the same message");
        assert_eq!(a.usage.cache_read, 100);
        assert_eq!(a.counts.tools, 1);
        assert_eq!(a.counts.errors, 1);
        let t = a.tools.back().unwrap();
        assert_eq!((t.ok, t.end_ts.is_some()), (Some(false), true), "tool result matched by id");
        assert_eq!(a.files.get("C:/p/a.ts").map(|f| f.writes), Some(1));
        assert_eq!(a.title.as_deref(), Some("Fix the bug"));
        assert_eq!(a.last, Last::ToolResult);
        assert!(a.open_tools.is_empty());
    }
}

