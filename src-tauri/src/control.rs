//! Control plane for sessions the user started themselves (terminal, IDE, background).
//!
//! Claude Code posts hook events to a local HTTP server owned by this app. Each
//! response can approve or deny a permission request, hold a tool call while the
//! session is paused, stop the turn, or hand Claude a message from the operator.
//! Hooks fail open: if the monitor is closed, Claude carries on unaffected.

use crate::model::{PendingPermission, QueuedMessage};
use crate::registry::claude_root;
use crate::transcript::{safe_truncate, tool_detail};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 47821;
const HOOK_PATH: &str = "/csm/hook/";
const HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 600),
    ("PermissionRequest", 600),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("Notification", 10),
    ("Stop", 15),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
    ("PreCompact", 10),
    ("SessionEnd", 10),
];

/// Sends an event to the UI: the Tauri window, or stdout in headless test mode
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub token: String,
    pub port: u16,
    /// "monitor_first" holds approvals for `approval_secs` then falls back to the
    /// terminal prompt; "monitor_only" holds up to ten minutes; "terminal" never holds.
    pub approval_mode: String,
    pub approval_secs: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            token: uuid::Uuid::new_v4().simple().to_string(),
            port: DEFAULT_PORT,
            approval_mode: "monitor_first".into(),
            approval_secs: 45,
        }
    }
}

fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claude-session-monitor")
        .join("config.json")
}

impl Config {
    pub fn load() -> Self {
        std::fs::read_to_string(config_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| {
                let c = Config::default();
                c.save();
                c
            })
    }
    pub fn save(&self) {
        let p = config_path();
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(self).unwrap_or_default());
    }
}

pub enum Decision {
    Allow,
    /// Deny with a message; `true` also interrupts the turn
    Deny(String, bool),
}

#[derive(Default)]
pub struct SessCtl {
    pub rev: u64,
    pub hooks: bool,
    pub paused: bool,
    pub stop_requested: bool,
    pub queued: Vec<QueuedMessage>,
    pub pending: Option<PendingPermission>,
    pub decision_tx: Option<mpsc::Sender<Decision>>,
    pub notification: Option<String>,
    pub notification_type: Option<String>,
    pub last_hook_at: Option<i64>,
    pub hook_status: Option<String>,
    pub cwd: Option<String>,
    pub transcript_path: Option<String>,
}

pub struct Hub {
    pub ctl: Mutex<HashMap<String, SessCtl>>,
    pub config: Mutex<Config>,
    pub dirty: AtomicBool,
    pub port: Mutex<Option<u16>>,
    /// Session ids launched by the monitor; their approvals always go through the monitor
    pub managed_ids: Mutex<std::collections::HashSet<String>>,
}

impl Hub {
    pub fn new() -> Self {
        Hub {
            ctl: Mutex::new(HashMap::new()),
            config: Mutex::new(Config::load()),
            dirty: AtomicBool::new(false),
            port: Mutex::new(None),
            managed_ids: Mutex::new(Default::default()),
        }
    }

    pub fn with<R>(&self, sid: &str, f: impl FnOnce(&mut SessCtl) -> R) -> R {
        let mut map = self.ctl.lock().unwrap();
        let c = map.entry(sid.to_string()).or_default();
        c.rev += 1;
        let r = f(c);
        self.dirty.store(true, Ordering::SeqCst);
        r
    }

    pub fn queue_message(&self, sid: &str, text: &str, steer: bool) -> QueuedMessage {
        let m = QueuedMessage {
            id: uuid::Uuid::new_v4().simple().to_string(),
            text: text.to_string(),
            ts: now_ms(),
            steer,
        };
        let q = m.clone();
        self.with(sid, |c| c.queued.push(q));
        m
    }

    /// Remove queued messages and join their text. `steer_only` takes just the
    /// "steer now" ones (delivered at the next tool call).
    fn take_queued(&self, sid: &str, steer_only: bool) -> Option<String> {
        self.with(sid, |c| {
            let (take, keep): (Vec<_>, Vec<_>) = c.queued.drain(..).partition(|m| m.steer || !steer_only);
            c.queued = keep;
            if take.is_empty() {
                None
            } else {
                Some(take.into_iter().map(|m| m.text).collect::<Vec<_>>().join("\n\n"))
            }
        })
    }

    pub fn resolve(&self, sid: &str, d: Decision) -> bool {
        self.with(sid, |c| match c.decision_tx.take() {
            Some(tx) => tx.send(d).is_ok(),
            None => false,
        })
    }
}

// Messages ride on channels Claude treats as the user's own voice: the Stop hook's
// "keep going because…" reason, the user's prompt context, or a tool denial reason.
// Text attached to tool output is (rightly) treated as untrusted, so it is not used.
fn turn_end_message(text: &str) -> String {
    format!(
        "The user sent you a new message from Claude Session Monitor while you were working. Treat it exactly as if they had typed it to you:\n\n{}",
        text
    )
}

fn steer_message(text: &str) -> String {
    format!(
        "The user held this tool call to send you a message from Claude Session Monitor. Read it and adjust your plan before continuing; retry the tool only if it still makes sense:\n\n{}",
        text
    )
}

// ───────────────────────── HTTP hook server ─────────────────────────

pub fn start_server(emit: Emit, hub: Arc<Hub>) {
    let preferred = hub.config.lock().unwrap().port;
    let mut server = None;
    for port in std::iter::once(preferred).chain(DEFAULT_PORT..DEFAULT_PORT + 20) {
        if let Ok(s) = tiny_http::Server::http(("127.0.0.1", port)) {
            server = Some((s, port));
            break;
        }
    }
    let Some((server, port)) = server else {
        eprintln!("control: no free port for the hook server");
        return;
    };
    *hub.port.lock().unwrap() = Some(port);
    {
        let mut cfg = hub.config.lock().unwrap();
        if cfg.port != port {
            cfg.port = port;
            cfg.save();
            // Keep installed hooks pointing at the port we actually got
            if hooks_installed() {
                let _ = install_hooks(&cfg);
            }
        }
    }
    let server = Arc::new(server);
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let emit = emit.clone();
            let hub = hub.clone();
            std::thread::spawn(move || {
                let token = hub.config.lock().unwrap().token.clone();
                let authed = req
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("x-csm-token") && h.value.as_str() == token);
                let url = req.url().to_string();
                if !authed || !url.starts_with(HOOK_PATH) {
                    let _ = req.respond(tiny_http::Response::empty(403));
                    return;
                }
                let event = url[HOOK_PATH.len()..].split('?').next().unwrap_or("").to_string();
                let mut body = String::new();
                let _ = req.as_reader().take(4 << 20).read_to_string(&mut body);
                let payload: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                let out = handle(&emit, &hub, &event, &payload);
                let text = out.map(|v| v.to_string()).unwrap_or_default();
                let resp = tiny_http::Response::from_string(text).with_header(
                    "Content-Type: application/json"
                        .parse::<tiny_http::Header>()
                        .unwrap(),
                );
                let _ = req.respond(resp);
            });
        }
    });
}

fn emit_event(emit: &Emit, sid: &str, event: &str, tool: Option<&str>, detail: &str) {
    emit(
        "hook-event",
        json!({
            "sessionId": sid,
            "event": event,
            "toolName": tool,
            "detail": safe_truncate(detail, 240),
            "ts": now_ms(),
        }),
    );
}

fn stop_output() -> Value {
    json!({"continue": false, "stopReason": "Stopped from Claude Session Monitor"})
}

fn handle(emit: &Emit, hub: &Hub, event: &str, p: &Value) -> Option<Value> {
    let sid = p.get("session_id").and_then(|v| v.as_str())?.to_string();
    let tool = p.get("tool_name").and_then(|v| v.as_str());
    let empty = json!({});
    let input = p.get("tool_input").unwrap_or(&empty);
    let detail = match tool {
        Some(t) => tool_detail(t, input).0,
        None => p
            .get("message")
            .or_else(|| p.get("prompt"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    };
    hub.with(&sid, |c| {
        c.hooks = true;
        c.last_hook_at = Some(now_ms());
        if let Some(cwd) = p.get("cwd").and_then(|v| v.as_str()) {
            c.cwd = Some(cwd.to_string());
        }
        if let Some(tp) = p.get("transcript_path").and_then(|v| v.as_str()) {
            c.transcript_path = Some(tp.to_string());
        }
    });
    emit_event(emit, &sid, event, tool, &detail);

    match event {
        "SessionStart" => {
            hub.with(&sid, |c| c.hook_status = Some("waiting".into()));
            None
        }
        "UserPromptSubmit" => {
            hub.with(&sid, |c| {
                c.hook_status = Some("working".into());
                c.notification_type = None;
            });
            hub.take_queued(&sid, false).map(|text| {
                json!({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": turn_end_message(&text)}})
            })
        }
        "PreToolUse" => {
            let (stop, paused) = hub.with(&sid, |c| {
                c.hook_status = Some("working".into());
                c.notification_type = None;
                (c.stop_requested, c.paused)
            });
            if stop {
                hub.with(&sid, |c| c.stop_requested = false);
                return Some(stop_output());
            }
            if paused {
                // Hold the tool call until the operator resumes or stops the session
                let start = Instant::now();
                loop {
                    std::thread::sleep(Duration::from_millis(200));
                    let map = hub.ctl.lock().unwrap();
                    let c = map.get(&sid);
                    let still = c.map(|c| c.paused).unwrap_or(false);
                    let stop = c.map(|c| c.stop_requested).unwrap_or(false);
                    drop(map);
                    if stop {
                        hub.with(&sid, |c| {
                            c.stop_requested = false;
                            c.paused = false;
                        });
                        return Some(stop_output());
                    }
                    if !still {
                        return None;
                    }
                    if start.elapsed() > Duration::from_secs(570) {
                        return Some(json!({"hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "permissionDecision": "deny",
                            "permissionDecisionReason": "The operator paused this session in Claude Session Monitor. Stop here and wait for further instructions."
                        }}));
                    }
                }
            }
            // "Steer now" messages: hold this tool call and hand Claude the message as the reason
            hub.take_queued(&sid, true).map(|text| {
                json!({"hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": steer_message(&text)
                }})
            })
        }
        "PermissionRequest" => {
            let managed = hub.managed_ids.lock().unwrap().contains(&sid);
            let (mode, secs) = {
                let c = hub.config.lock().unwrap();
                (c.approval_mode.clone(), c.approval_secs)
            };
            let hold = if managed || mode == "monitor_only" {
                590
            } else if mode == "terminal" {
                0
            } else {
                secs.clamp(5, 590)
            };
            let (tx, rx) = mpsc::channel();
            let pending = PendingPermission {
                id: uuid::Uuid::new_v4().simple().to_string(),
                tool_name: tool.unwrap_or("?").to_string(),
                detail: detail.clone(),
                input: input.clone(),
                ts: now_ms(),
                hold_secs: hold,
                held: hold > 0,
            };
            hub.with(&sid, |c| {
                c.pending = Some(pending);
                c.decision_tx = if hold > 0 { Some(tx) } else { None };
                c.hook_status = Some("blocked".into());
            });
            emit("attention", json!({"sessionId": sid, "kind": "permission", "tool": tool, "detail": detail}));
            if hold == 0 {
                return None;
            }
            let result = rx.recv_timeout(Duration::from_secs(hold));
            let out = match result {
                Ok(Decision::Allow) => Some(json!({"hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {"behavior": "allow"}
                }})),
                Ok(Decision::Deny(msg, interrupt)) => Some(json!({"hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "deny",
                        "message": if msg.is_empty() { "Denied from Claude Session Monitor".to_string() } else { msg },
                        "interrupt": interrupt
                    }
                }})),
                Err(_) => None,
            };
            hub.with(&sid, |c| {
                c.decision_tx = None;
                if out.is_some() {
                    c.pending = None;
                    c.hook_status = Some("working".into());
                } else if let Some(p) = c.pending.as_mut() {
                    // Timed out: the terminal prompt takes over
                    p.held = false;
                }
            });
            out
        }
        "PostToolUse" | "PostToolUseFailure" => {
            let stop = hub.with(&sid, |c| {
                c.pending = None;
                c.hook_status = Some("working".into());
                let s = c.stop_requested;
                c.stop_requested = false;
                s
            });
            if stop {
                return Some(stop_output());
            }
            None
        }
        "Notification" => {
            let ntype = p.get("notification_type").and_then(|v| v.as_str()).map(String::from);
            let msg = p.get("message").and_then(|v| v.as_str()).map(String::from);
            hub.with(&sid, |c| {
                if ntype.as_deref() == Some("permission_prompt") {
                    c.hook_status = Some("blocked".into());
                } else if ntype.as_deref() == Some("idle_prompt") {
                    c.hook_status = Some("waiting".into());
                }
                c.notification_type = ntype.clone();
                c.notification = msg;
            });
            if ntype.as_deref() == Some("permission_prompt") {
                emit("attention", json!({"sessionId": sid, "kind": "permission", "detail": detail}));
            }
            None
        }
        "Stop" => {
            hub.with(&sid, |c| {
                c.pending = None;
                c.stop_requested = false;
                c.hook_status = Some("waiting".into());
            });
            match hub.take_queued(&sid, false) {
                Some(text) => {
                    hub.with(&sid, |c| c.hook_status = Some("working".into()));
                    Some(json!({"decision": "block", "reason": turn_end_message(&text)}))
                }
                None => None,
            }
        }
        "PreCompact" => {
            hub.with(&sid, |c| c.hook_status = Some("compacting".into()));
            None
        }
        "SessionEnd" => {
            hub.with(&sid, |c| {
                c.pending = None;
                c.hook_status = Some("ended".into());
            });
            None
        }
        _ => None,
    }
}

// ───────────────────────── settings.json installer ─────────────────────────

fn settings_path() -> PathBuf {
    claude_root().join("settings.json")
}

fn is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hs| {
            hs.iter().any(|h| {
                h.get("url")
                    .and_then(|u| u.as_str())
                    .map(|u| u.contains(HOOK_PATH))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn read_settings() -> Result<Value, String> {
    match std::fs::read_to_string(settings_path()) {
        Ok(t) if t.trim().is_empty() => Ok(json!({})),
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("settings.json is not valid JSON: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}

fn write_settings(v: &Value) -> Result<(), String> {
    let path = settings_path();
    if path.exists() {
        let backup = path.with_file_name(format!(
            "settings.json.csm-backup-{}",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ));
        std::fs::copy(&path, &backup).map_err(|e| format!("backup failed: {e}"))?;
    }
    let tmp = path.with_extension("json.csm-tmp");
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn strip_ours(settings: &mut Value) {
    if let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for (_, groups) in hooks.iter_mut() {
            if let Some(arr) = groups.as_array_mut() {
                arr.retain(|g| !is_ours(g));
            }
        }
        hooks.retain(|_, g| g.as_array().map(|a| !a.is_empty()).unwrap_or(true));
    }
    if settings
        .get("hooks")
        .and_then(|h| h.as_object())
        .map(|o| o.is_empty())
        .unwrap_or(false)
    {
        settings.as_object_mut().map(|o| o.remove("hooks"));
    }
}

/// Hook groups for every event we listen to, keyed by event name
pub fn hook_groups(cfg: &Config) -> Value {
    let mut map = serde_json::Map::new();
    for (event, timeout) in HOOK_EVENTS {
        map.insert(
            event.to_string(),
            json!([{
                "hooks": [{
                    "type": "http",
                    "url": format!("http://127.0.0.1:{}{}{}", cfg.port, HOOK_PATH, event),
                    "timeout": timeout,
                    "headers": {"X-CSM-Token": cfg.token}
                }]
            }]),
        );
    }
    Value::Object(map)
}

pub fn hooks_installed() -> bool {
    read_settings()
        .ok()
        .and_then(|s| s.get("hooks").cloned())
        .and_then(|h| h.as_object().cloned())
        .map(|o| o.values().any(|g| g.as_array().map(|a| a.iter().any(is_ours)).unwrap_or(false)))
        .unwrap_or(false)
}

pub fn install_hooks(cfg: &Config) -> Result<(), String> {
    let mut settings = read_settings()?;
    if !settings.is_object() {
        return Err("settings.json is not a JSON object".into());
    }
    strip_ours(&mut settings);
    let obj = settings.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        return Err("settings.json has a non-object \"hooks\" key".into());
    }
    let ours = hook_groups(cfg);
    for (event, groups) in ours.as_object().unwrap() {
        let slot = hooks
            .as_object_mut()
            .unwrap()
            .entry(event.clone())
            .or_insert_with(|| json!([]));
        if let (Some(arr), Some(new)) = (slot.as_array_mut(), groups.as_array()) {
            arr.extend(new.iter().cloned());
        }
    }
    write_settings(&settings)
}

pub fn uninstall_hooks() -> Result<(), String> {
    let mut settings = read_settings()?;
    strip_ours(&mut settings);
    write_settings(&settings)
}

/// Settings JSON passed to sessions the monitor launches, so they report to us
/// even when the user has not installed the global hooks.
pub fn launch_settings(cfg: &Config) -> String {
    json!({"hooks": hook_groups(cfg)}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Install then uninstall against a throwaway config dir: the user's own hooks and
    /// key order must survive, and uninstall must restore the file exactly.
    #[test]
    fn install_and_uninstall_round_trip() {
        let dir = std::env::temp_dir().join(format!("csm-hooks-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", &dir);
        let original = json!({
            "env": {"A": "1"},
            "permissions": {"allow": ["Bash(git status)"]},
            "hooks": {
                "Stop": [{"matcher": "*", "hooks": [{"type": "command", "command": "python check.py"}]}],
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "guard.exe"}]}]
            },
            "model": "opus"
        });
        std::fs::write(dir.join("settings.json"), serde_json::to_string_pretty(&original).unwrap()).unwrap();

        let cfg = Config { token: "t0k".into(), port: 47999, approval_mode: "monitor_first".into(), approval_secs: 45 };
        install_hooks(&cfg).unwrap();
        assert!(hooks_installed());
        let after: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        let keys: Vec<&String> = after.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["env", "permissions", "hooks", "model"], "top-level key order kept");
        assert_eq!(after["hooks"]["Stop"].as_array().unwrap().len(), 2, "user Stop hook kept, ours added");
        assert_eq!(after["hooks"]["Stop"][0]["hooks"][0]["command"], "python check.py");
        assert_eq!(after["hooks"]["PreToolUse"][1]["hooks"][0]["url"], "http://127.0.0.1:47999/csm/hook/PreToolUse");
        assert_eq!(after["hooks"]["PermissionRequest"][0]["hooks"][0]["headers"]["X-CSM-Token"], "t0k");

        // Installing twice must not duplicate our hooks
        install_hooks(&cfg).unwrap();
        let twice: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(twice["hooks"]["Stop"].as_array().unwrap().len(), 2);

        uninstall_hooks().unwrap();
        assert!(!hooks_installed());
        let restored: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(restored, original, "uninstall restores the original settings");
        let backups = std::fs::read_dir(&dir).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("csm-backup")).count();
        assert!(backups >= 1, "a backup is written before changes");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
