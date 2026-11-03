//! Live Claude processes: `~/.claude/sessions/<pid>.json` (written by every running
//! Claude Code process) joined with the OS process table to find where each
//! session runs (VS Code, Windows Terminal, iTerm2, ...).

use crate::model::ProcessInfo;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Clone, Debug)]
pub struct RegEntry {
    pub pid: u32,
    pub session_id: String,
    pub cwd: Option<String>,
    pub kind: String,
    pub entrypoint: Option<String>,
    pub name: Option<String>,
    pub status: String,
    pub version: Option<String>,
    pub started_at: Option<i64>,
}

pub fn claude_root() -> PathBuf {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
}

pub fn read_registry() -> Vec<RegEntry> {
    let dir = claude_root().join("sessions");
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let v: Value = match std::fs::read_to_string(&p)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
        {
            Some(v) => v,
            None => continue,
        };
        let g = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
        let (Some(pid), Some(session_id)) = (v.get("pid").and_then(|x| x.as_u64()), g("sessionId"))
        else {
            continue;
        };
        out.push(RegEntry {
            pid: pid as u32,
            session_id,
            cwd: g("cwd"),
            kind: g("kind").unwrap_or_else(|| "interactive".into()),
            entrypoint: g("entrypoint"),
            name: g("name"),
            status: g("status").unwrap_or_else(|| "idle".into()),
            version: g("version"),
            started_at: v.get("startedAt").and_then(|x| x.as_i64()),
        });
    }
    out
}

/// Map a process image name to the app a person would recognise
fn app_label(exe: &str) -> Option<&'static str> {
    let e = exe.to_ascii_lowercase();
    let e = e.trim_end_matches(".exe");
    Some(match e {
        "code" | "code - insiders" | "code-insiders" => "VS Code",
        "cursor" => "Cursor",
        "windsurf" => "Windsurf",
        "windowsterminal" | "wt" => "Windows Terminal",
        "wezterm-gui" | "wezterm" => "WezTerm",
        "alacritty" => "Alacritty",
        "kitty" => "kitty",
        "ghostty" => "Ghostty",
        "warp" | "stable" => "Warp",
        "iterm2" => "iTerm2",
        "terminal" => "Terminal",
        "hyper" => "Hyper",
        "tabby" => "Tabby",
        "zed" => "Zed",
        "tmux" | "tmux: server" => "tmux",
        "claude-session-monitor" => "Session Monitor",
        _ if e.starts_with("idea") || e.starts_with("webstorm") || e.starts_with("pycharm")
            || e.starts_with("rider") || e.starts_with("goland") || e.starts_with("clion")
            || e.starts_with("rustrover") || e.starts_with("phpstorm") => "JetBrains",
        _ => return None,
    })
}

fn shell_label(exe: &str) -> Option<&'static str> {
    let e = exe.to_ascii_lowercase();
    let e = e.trim_end_matches(".exe");
    Some(match e {
        "pwsh" => "PowerShell",
        "powershell" => "Windows PowerShell",
        "cmd" => "Command Prompt",
        "bash" => "bash",
        "zsh" => "zsh",
        "fish" => "fish",
        "nu" => "Nushell",
        _ => return None,
    })
}

fn entrypoint_label(ep: &str) -> Option<&'static str> {
    Some(match ep {
        "claude-vscode" => "VS Code",
        "claude-jetbrains" => "JetBrains",
        "claude-desktop" => "Claude Desktop",
        "sdk-ts" | "sdk-py" | "sdk-cli" => "Agent SDK",
        "cli" => "Terminal",
        _ => return None,
    })
}

pub struct Procs {
    sys: Option<System>,
    pub machine: String,
}

impl Procs {
    pub fn new() -> Self {
        let machine = System::host_name().unwrap_or_else(|_| "this machine".into());
        Procs {
            sys: System::new().ok(),
            machine,
        }
    }

    pub fn refresh(&mut self) {
        if let Some(sys) = self.sys.as_mut() {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .with_cpu()
                    .with_memory()
                    .with_exe(UpdateKind::OnlyIfNotSet),
            );
        }
    }

    pub fn alive(&self, pid: u32) -> bool {
        match &self.sys {
            Some(sys) => sys.process(Pid::from_u32(pid)).is_some(),
            // Without a process table, trust the registry
            None => true,
        }
    }

    pub fn kill(&self, pid: u32) -> bool {
        self.sys
            .as_ref()
            .and_then(|s| s.process(Pid::from_u32(pid)))
            .map(|p| p.kill())
            .unwrap_or(false)
    }

    pub fn info(&self, r: &RegEntry) -> ProcessInfo {
        let mut chain = Vec::new();
        let mut host: Option<String> = None;
        let mut shell: Option<String> = None;
        let (mut cpu, mut mem) = (0.0f32, 0u64);
        if let Some(sys) = &self.sys {
            if let Some(p) = sys.process(Pid::from_u32(r.pid)) {
                cpu = p.cpu_usage();
                mem = p.memory() / (1024 * 1024);
                let mut cur = p.parent();
                let mut depth = 0;
                while let (Some(pp), true) = (cur, depth < 10) {
                    let Some(proc_) = sys.process(pp) else { break };
                    let name = proc_.name().to_string_lossy().to_string();
                    if host.is_none() {
                        if let Some(l) = app_label(&name) {
                            host = Some(l.to_string());
                        }
                    }
                    if shell.is_none() {
                        if let Some(l) = shell_label(&name) {
                            shell = Some(l.to_string());
                        }
                    }
                    chain.push(name);
                    cur = proc_.parent();
                    depth += 1;
                }
            }
        }
        let host = host
            .or_else(|| r.entrypoint.as_deref().and_then(entrypoint_label).map(String::from))
            .or(shell)
            .unwrap_or_else(|| "Terminal".into());
        ProcessInfo {
            pid: r.pid,
            kind: r.kind.clone(),
            entrypoint: r.entrypoint.clone(),
            host,
            host_chain: chain,
            name: r.name.clone(),
            version: r.version.clone(),
            machine: self.machine.clone(),
            cpu,
            mem_mb: mem,
            started_at: r.started_at,
        }
    }
}

/// Registry entries for processes that are still running, keyed by session id
pub fn live_entries(procs: &Procs) -> HashMap<String, RegEntry> {
    let mut map = HashMap::new();
    for r in read_registry() {
        if procs.alive(r.pid) {
            map.insert(r.session_id.clone(), r);
        }
    }
    map
}
