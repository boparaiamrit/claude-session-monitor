//! Joins transcripts, the live process registry, hook state and managed sessions
//! into `Session` views, and works out which ones changed since the last tick.

use crate::control::{now_ms, Hub, SessCtl};
use crate::model::*;
use crate::registry::{claude_root, live_entries, Procs, RegEntry};
use crate::transcript::{Last, Transcript};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

struct AgentFile {
    meta: Value,
    t: Transcript,
}

pub struct Engine {
    transcripts: HashMap<PathBuf, Transcript>,
    agents: HashMap<PathBuf, AgentFile>,
    procs: Procs,
    last_proc_refresh: Option<Instant>,
    live: HashMap<String, RegEntry>,
    sent: HashMap<String, u64>,
    /// status and liveness of every session from the last tick (for the tray summary)
    statuses: HashMap<String, (String, bool)>,
    pub window_hours: f64,
}

fn mtime_secs(p: &Path) -> f64 {
    p.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn project_name(cwd: Option<&str>, project: &str) -> String {
    if let Some(c) = cwd {
        if let Some(last) = c.replace('\\', "/").split('/').filter(|x| !x.is_empty()).last() {
            return last.to_string();
        }
    }
    project.rsplit('-').next().unwrap_or(project).to_string()
}

impl Engine {
    pub fn new() -> Self {
        Engine {
            transcripts: HashMap::new(),
            agents: HashMap::new(),
            procs: Procs::new(),
            last_proc_refresh: None,
            live: HashMap::new(),
            sent: HashMap::new(),
            statuses: HashMap::new(),
            window_hours: 24.0,
        }
    }

    pub fn machine(&self) -> String {
        self.procs.machine.clone()
    }

    pub fn kill_pid(&mut self, pid: u32) -> bool {
        self.procs.refresh();
        self.procs.kill(pid)
    }

    pub fn session_cwd(&self, sid: &str) -> Option<String> {
        self.transcripts
            .values()
            .find(|t| t.acc.session_id.as_deref() == Some(sid) || t.path.file_stem().and_then(|s| s.to_str()) == Some(sid))
            .and_then(|t| t.acc.cwd.clone())
            .or_else(|| self.live.get(sid).and_then(|r| r.cwd.clone()))
    }

    /// (working, needs you, your turn) across live sessions
    pub fn counts(&self) -> (usize, usize, usize) {
        let mut c = (0, 0, 0);
        for (status, live) in self.statuses.values() {
            match status.as_str() {
                "working" if *live => c.0 += 1,
                "blocked" => c.1 += 1,
                "waiting" if *live => c.2 += 1,
                _ => {}
            }
        }
        c
    }

    pub fn live_entry(&self, sid: &str) -> Option<RegEntry> {
        self.live.get(sid).cloned()
    }

    /// Discover and incrementally parse every transcript inside the time window
    fn scan(&mut self, keep: &HashSet<String>) {
        let root = claude_root().join("projects");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let cutoff = now - self.window_hours * 3600.0;
        let mut seen: HashSet<PathBuf> = HashSet::new();
        let Ok(dirs) = std::fs::read_dir(&root) else { return };
        for dir in dirs.flatten() {
            let dpath = dir.path();
            if !dpath.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&dpath) else { continue };
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                if mtime_secs(&p) < cutoff && !keep.contains(&stem) {
                    continue;
                }
                seen.insert(p.clone());
                self.transcripts
                    .entry(p.clone())
                    .or_insert_with(|| Transcript::new(p.clone()))
                    .update();
                // Sub-agent transcripts live in <session-id>/subagents/
                let sub = dpath.join(&stem).join("subagents");
                if let Ok(afiles) = std::fs::read_dir(&sub) {
                    for af in afiles.flatten() {
                        let ap = af.path();
                        if ap.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                            continue;
                        }
                        seen.insert(ap.clone());
                        let entry = self.agents.entry(ap.clone()).or_insert_with(|| {
                            let meta = std::fs::read_to_string(ap.with_extension("meta.json"))
                                .ok()
                                .and_then(|t| serde_json::from_str(&t).ok())
                                .unwrap_or(Value::Null);
                            AgentFile {
                                meta,
                                t: Transcript::new(ap.clone()),
                            }
                        });
                        entry.t.update();
                    }
                }
            }
        }
        self.transcripts.retain(|p, _| seen.contains(p));
        self.agents.retain(|p, _| seen.contains(p));
    }

    fn agents_for(&self, t: &Transcript, live: bool, now: i64) -> (Vec<Agent>, u64) {
        let dir = t
            .path
            .parent()
            .map(|d| d.join(t.path.file_stem().unwrap_or_default()).join("subagents"));
        let files: Vec<(&PathBuf, &AgentFile)> = match &dir {
            Some(d) => self.agents.iter().filter(|(p, _)| p.starts_with(d)).collect(),
            None => vec![],
        };
        let mut ver = 0u64;
        let mut used: HashSet<&PathBuf> = HashSet::new();
        let mut out: Vec<Agent> = Vec::new();
        let launches = &t.acc.launches;
        let start = launches.len().saturating_sub(40);
        for l in &launches[start..] {
            let file = files.iter().find(|(_, a)| {
                a.meta.get("toolUseId").and_then(|v| v.as_str()) == Some(l.tool_use_id.as_str())
            });
            let (status, last_act, cur, count, tools, usage, text, id) = match file {
                Some((p, a)) => {
                    used.insert(*p);
                    ver = ver.wrapping_add(a.t.version);
                    let acc = &a.t.acc;
                    let finished = acc.last == Last::AssistantEnd && acc.open_tools.is_empty();
                    let stale = acc
                        .last_activity
                        .map(|la| now - la > 10 * 60_000 && !live)
                        .unwrap_or(false);
                    let status = if l.error {
                        "error"
                    } else if l.done || finished || stale {
                        "done"
                    } else {
                        "working"
                    };
                    let id = p
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .trim_start_matches("agent-")
                        .to_string();
                    let tools: Vec<ToolCall> = acc.tools.iter().rev().take(25).rev().cloned().collect();
                    (
                        status,
                        acc.last_activity,
                        if status == "working" { acc.current_tool.clone() } else { None },
                        acc.counts.tools,
                        tools,
                        acc.usage.clone(),
                        acc.last_text.clone(),
                        id,
                    )
                }
                None => {
                    let status = if l.error {
                        "error"
                    } else if l.done || !live || now - l.ts > 30 * 60_000 {
                        "done"
                    } else {
                        "working"
                    };
                    (status, l.end_ts.or(Some(l.ts)), None, 0, vec![], Usage::default(), None, l.tool_use_id.clone())
                }
            };
            out.push(Agent {
                id,
                tool_use_id: Some(l.tool_use_id.clone()),
                agent_type: l.agent_type.clone(),
                description: l.description.clone(),
                model: l.model.clone(),
                background: l.background,
                started_at: Some(l.ts),
                last_activity: last_act,
                status: status.into(),
                current_tool: cur,
                tool_count: count,
                tools,
                usage,
                last_text: text,
            });
        }
        // Agent transcripts whose launch fell outside the window we kept
        for (p, a) in files {
            if used.contains(p) {
                continue;
            }
            ver = ver.wrapping_add(a.t.version);
            let acc = &a.t.acc;
            let finished = acc.last == Last::AssistantEnd && acc.open_tools.is_empty();
            let stale = acc.last_activity.map(|la| now - la > 10 * 60_000).unwrap_or(true);
            let g = |k: &str| a.meta.get(k).and_then(|v| v.as_str()).map(String::from);
            out.push(Agent {
                id: p.file_stem().and_then(|s| s.to_str()).unwrap_or("").trim_start_matches("agent-").to_string(),
                tool_use_id: g("toolUseId"),
                agent_type: g("agentType").unwrap_or_else(|| "general-purpose".into()),
                description: g("description").unwrap_or_default(),
                model: acc.model.clone(),
                background: g("requestShape").as_deref() == Some("background"),
                started_at: acc.started_at,
                last_activity: acc.last_activity,
                status: if finished || stale || !live { "done" } else { "working" }.into(),
                current_tool: None,
                tool_count: acc.counts.tools,
                tools: acc.tools.iter().rev().take(25).rev().cloned().collect(),
                usage: acc.usage.clone(),
                last_text: acc.last_text.clone(),
            });
        }
        out.sort_by_key(|a| a.started_at.unwrap_or(0));
        (out, ver)
    }

    fn build(
        &self,
        t: &Transcript,
        reg: Option<&RegEntry>,
        ctl: Option<&SessCtl>,
        managed: Option<bool>,
        now: i64,
    ) -> (Session, u64) {
        let acc = &t.acc;
        let id = t
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let project = t
            .path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let live = reg.is_some() || managed.is_some();
        let hook_fresh = ctl
            .and_then(|c| c.last_hook_at)
            .map(|h| now - h < 15 * 60_000)
            .unwrap_or(false);
        let since = acc.last_activity.map(|la| now - la).unwrap_or(i64::MAX);
        let transcript_busy = !acc.open_tools.is_empty()
            || matches!(acc.last, Last::UserPrompt | Last::ToolResult | Last::AssistantStreaming | Last::AssistantTool);

        let status = if ctl.map(|c| c.pending.is_some()).unwrap_or(false)
            || (hook_fresh && ctl.and_then(|c| c.hook_status.as_deref()) == Some("blocked"))
        {
            "blocked"
        } else if let Some(busy) = managed {
            if busy { "working" } else { "waiting" }
        } else if let Some(r) = reg {
            if r.status == "busy" { "working" } else { "waiting" }
        } else if since < 120_000 && transcript_busy {
            // No registry entry (older Claude Code): fall back to transcript recency
            "working"
        } else {
            "idle"
        };

        let process = reg.map(|r| self.procs.info(r));
        let (agents, agent_ver) = self.agents_for(t, live, now);

        let control = match ctl {
            Some(c) => ControlState {
                hooks: c.hooks,
                managed: managed.is_some(),
                managed_busy: managed.unwrap_or(false),
                paused: c.paused,
                stop_requested: c.stop_requested,
                queued: c.queued.clone(),
                pending: c.pending.clone(),
                notification: c.notification.clone(),
                last_hook_at: c.last_hook_at,
            },
            None => ControlState {
                managed: managed.is_some(),
                managed_busy: managed.unwrap_or(false),
                ..Default::default()
            },
        };

        let mut files: Vec<FileTouch> = acc.files.values().cloned().collect();
        files.sort_by(|a, b| b.last_ts.cmp(&a.last_ts));
        files.truncate(120);

        let current_tool = if status == "working" || status == "blocked" {
            acc.current_tool.clone()
        } else {
            None
        };

        let mut h = DefaultHasher::new();
        (
            t.version,
            agent_ver,
            status,
            live,
            ctl.map(|c| c.rev).unwrap_or(0),
            process.as_ref().map(|p| (p.pid, (p.cpu / 5.0) as i32, p.mem_mb / 64)),
            now / 60_000, // refresh "activity" once a minute
        )
            .hash(&mut h);

        let s = Session {
            id: id.clone(),
            project: project.clone(),
            project_name: project_name(acc.cwd.as_deref().or(reg.and_then(|r| r.cwd.as_deref())), &project),
            cwd: acc.cwd.clone().or_else(|| reg.and_then(|r| r.cwd.clone())),
            title: acc.title.clone().or_else(|| reg.and_then(|r| r.name.clone())),
            model: acc.model.clone(),
            version: acc.version.clone().or_else(|| reg.and_then(|r| r.version.clone())),
            git_branch: acc.git_branch.clone(),
            permission_mode: acc.permission_mode.clone(),
            effort: acc.effort.clone(),
            entrypoint: acc.entrypoint.clone().or_else(|| reg.and_then(|r| r.entrypoint.clone())),
            started_at: acc.started_at.or(reg.and_then(|r| r.started_at)),
            last_activity: acc.last_activity,
            status: status.into(),
            live,
            process,
            control,
            current_tool,
            thinking: acc.thinking.clone(),
            last_prompt: acc.last_prompt.clone(),
            last_text: acc.last_text.clone(),
            counts: acc.counts.clone(),
            usage: acc.usage.clone(),
            usage_by_model: acc.usage_by_model.clone(),
            context_tokens: acc.context_tokens,
            tools: acc.tools.iter().rev().take(150).rev().cloned().collect(),
            messages: acc.messages.iter().cloned().collect(),
            agents,
            files,
            todos: acc.todos.clone(),
            activity: acc.activity(now),
            hourly: acc.hours.values().cloned().collect(),
            file_size: t.file_size,
            transcript: t.path.to_string_lossy().to_string(),
        };
        (s, h.finish())
    }

    /// One pass: rescan, rebuild, and return the sessions that changed.
    pub fn tick(&mut self, hub: &Hub, managed: &HashMap<String, bool>, full: bool) -> Delta {
        let refresh_due = self
            .last_proc_refresh
            .map(|t| t.elapsed().as_millis() > 2500)
            .unwrap_or(true);
        if refresh_due {
            self.procs.refresh();
            self.last_proc_refresh = Some(Instant::now());
        }
        self.live = live_entries(&self.procs);

        let mut keep: HashSet<String> = self.live.keys().cloned().collect();
        keep.extend(managed.keys().cloned());
        self.scan(&keep);

        let now = now_ms();
        let ctl_map = hub.ctl.lock().unwrap();
        let mut upserts = Vec::new();
        let mut current: HashSet<String> = HashSet::new();
        for t in self.transcripts.values() {
            let id = t.path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            // Skip empty shells (no messages yet) unless they're live
            if t.acc.counts.user == 0 && t.acc.counts.assistant == 0 && !self.live.contains_key(id) && !managed.contains_key(id) {
                continue;
            }
            let (s, hash) = self.build(t, self.live.get(id), ctl_map.get(id), managed.get(id).copied(), now);
            current.insert(s.id.clone());
            self.statuses.insert(s.id.clone(), (s.status.clone(), s.live));
            if full || self.sent.get(&s.id) != Some(&hash) {
                self.sent.insert(s.id.clone(), hash);
                upserts.push(s);
            }
        }
        drop(ctl_map);
        let removed: Vec<String> = self
            .sent
            .keys()
            .filter(|k| !current.contains(*k))
            .cloned()
            .collect();
        for r in &removed {
            self.sent.remove(r);
            self.statuses.remove(r);
        }
        Delta { upserts, removed, full }
    }
}
