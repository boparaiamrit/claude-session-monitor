//! Sessions the monitor launches and drives itself, plus OS hand-offs
//! (open a terminal on a session, open the folder or editor, launch `claude --bg`).

use crate::control::{hooks_installed, launch_settings, now_ms, Emit, Hub};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// `claude` as installed: a native binary on PATH, or the npm `claude.cmd` shim on Windows
fn claude_command() -> Command {
    #[cfg(windows)]
    {
        let native = Command::new("claude")
            .arg("--version")
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok();
        if !native {
            return Command::new("claude.cmd");
        }
    }
    Command::new("claude")
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartOpts {
    pub cwd: String,
    pub prompt: String,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub name: Option<String>,
    /// "managed" (chat inside the monitor), "background" (`claude --bg`) or "terminal"
    pub mode: String,
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    busy: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Managed {
    procs: Mutex<HashMap<String, Proc>>,
    /// Extra CLI flags for every launch (the headless tests use this to skip user settings)
    pub extra_args: Vec<String>,
}

impl Managed {
    pub fn with_args(extra_args: Vec<String>) -> Self {
        Managed {
            extra_args,
            ..Default::default()
        }
    }

    pub fn running(&self) -> HashMap<String, bool> {
        let mut map = self.procs.lock().unwrap();
        map.retain(|_, p| matches!(p.child.try_wait(), Ok(None)));
        map.iter()
            .map(|(k, p)| (k.clone(), p.busy.load(Ordering::SeqCst)))
            .collect()
    }

    pub fn is_running(&self, sid: &str) -> bool {
        self.running().contains_key(sid)
    }

    /// Spawn `claude -p` in bidirectional stream-json mode. `resume` continues an
    /// existing conversation under its own id.
    pub fn spawn(
        &self,
        emit: &Emit,
        hub: &Arc<Hub>,
        cwd: &str,
        resume: Option<&str>,
        model: Option<&str>,
        permission_mode: Option<&str>,
    ) -> Result<String, String> {
        let sid = resume
            .map(String::from)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if self.is_running(&sid) {
            return Ok(sid);
        }
        let mut cmd = claude_command();
        cmd.current_dir(cwd).args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
        ]);
        match resume {
            Some(id) => cmd.args(["--resume", id]),
            None => cmd.args(["--session-id", &sid]),
        };
        if let Some(m) = model.filter(|m| !m.is_empty()) {
            cmd.args(["--model", m]);
        }
        if let Some(pm) = permission_mode.filter(|m| !m.is_empty()) {
            cmd.args(["--permission-mode", pm]);
        }
        cmd.args(&self.extra_args);
        if !hooks_installed() {
            let cfg = hub.config.lock().unwrap().clone();
            cmd.args(["--settings", &launch_settings(&cfg)]);
        }
        hidden(&mut cmd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("could not start claude: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take();
        let busy = Arc::new(AtomicBool::new(false));
        hub.managed_ids.lock().unwrap().insert(sid.clone());

        let (emit2, sid2, busy2, hub2) = (emit.clone(), sid.clone(), busy.clone(), hub.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v.get("type").and_then(|t| t.as_str()) == Some("result") {
                    busy2.store(false, Ordering::SeqCst);
                    hub2.dirty.store(true, Ordering::SeqCst);
                }
                emit2("managed-event", json!({"sessionId": sid2, "data": v}));
            }
            busy2.store(false, Ordering::SeqCst);
            hub2.managed_ids.lock().unwrap().remove(&sid2);
            hub2.dirty.store(true, Ordering::SeqCst);
            emit2("managed-exit", json!({"sessionId": sid2}));
        });
        if let Some(err) = stderr {
            let (emit3, sid3) = (emit.clone(), sid.clone());
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        emit3("managed-event", json!({"sessionId": sid3, "data": {"type": "stderr", "text": line}}));
                    }
                }
            });
        }
        self.procs
            .lock()
            .unwrap()
            .insert(sid.clone(), Proc { child, stdin, busy });
        hub.dirty.store(true, Ordering::SeqCst);
        Ok(sid)
    }

    fn write(&self, sid: &str, v: &Value) -> Result<(), String> {
        let mut map = self.procs.lock().unwrap();
        let p = map.get_mut(sid).ok_or("session is not running in the monitor")?;
        let mut line = v.to_string();
        line.push('\n');
        p.stdin
            .write_all(line.as_bytes())
            .and_then(|_| p.stdin.flush())
            .map_err(|e| e.to_string())
    }

    pub fn send(&self, sid: &str, text: &str) -> Result<(), String> {
        self.write(
            sid,
            &json!({
                "type": "user",
                "message": {"role": "user", "content": text},
                "parent_tool_use_id": null,
                "session_id": sid,
            }),
        )?;
        if let Some(p) = self.procs.lock().unwrap().get(sid) {
            p.busy.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    /// Interrupt the current turn; the process keeps running and accepts new messages
    pub fn interrupt(&self, sid: &str) -> Result<(), String> {
        self.write(
            sid,
            &json!({
                "type": "control_request",
                "request_id": format!("csm-{}", now_ms()),
                "request": {"subtype": "interrupt"},
            }),
        )
    }

    pub fn kill(&self, sid: &str) -> bool {
        match self.procs.lock().unwrap().remove(sid) {
            Some(mut p) => p.child.kill().is_ok(),
            None => false,
        }
    }

    pub fn kill_all(&self) {
        for (_, mut p) in self.procs.lock().unwrap().drain() {
            let _ = p.child.kill();
        }
    }
}

/// `claude --bg` in `cwd`; returns whatever the CLI printed (it includes the short id)
pub fn start_background(o: &StartOpts) -> Result<String, String> {
    let mut cmd = claude_command();
    cmd.current_dir(&o.cwd).arg("--bg");
    if let Some(n) = o.name.as_deref().filter(|n| !n.is_empty()) {
        cmd.args(["--name", n]);
    }
    if let Some(m) = o.model.as_deref().filter(|m| !m.is_empty()) {
        cmd.args(["--model", m]);
    }
    if let Some(pm) = o.permission_mode.as_deref().filter(|m| !m.is_empty()) {
        cmd.args(["--permission-mode", pm]);
    }
    cmd.arg(&o.prompt);
    let out = hidden(&mut cmd)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not start claude: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(format!(
            "{} {}",
            text,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

pub fn stop_background(id: &str) -> Result<(), String> {
    let out = hidden(claude_command().args(["stop", id]))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Open a plain terminal window in `cwd`
pub fn open_shell(cwd: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        if Command::new("wt.exe").args(["-d", cwd]).spawn().is_ok() {
            return Ok(());
        }
        return Command::new("cmd")
            .args(["/C", "start", "Terminal", "/D", cwd, "cmd"])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    {
        return Command::new("open")
            .args(["-a", "Terminal", cwd])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if Command::new(term).current_dir(cwd).spawn().is_ok() {
                return Ok(());
            }
        }
        return Err("no terminal emulator found".into());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

/// Open a new terminal window in `cwd` running `claude` with `args`
pub fn open_terminal(cwd: &str, args: &[&str]) -> Result<(), String> {
    #[cfg(windows)]
    {
        let wt = Command::new("wt.exe")
            .args(["-d", cwd, "claude"])
            .args(args)
            .spawn();
        if wt.is_ok() {
            return Ok(());
        }
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "Claude", "/D", cwd, "cmd", "/K", "claude"])
            .args(args);
        return c.spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let line = format!(
            "cd {} && claude {}",
            shell_quote(cwd),
            args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ")
        );
        let script = format!(
            "tell application \"Terminal\" to do script \"{}\"\ntell application \"Terminal\" to activate",
            line.replace('\\', "\\\\").replace('"', "\\\"")
        );
        return Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let line = format!(
            "cd {} && claude {}; exec $SHELL",
            shell_quote(cwd),
            args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ")
        );
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            let r = if term == "gnome-terminal" {
                Command::new(term).args(["--", "sh", "-c", &line]).spawn()
            } else {
                Command::new(term).args(["-e", "sh", "-c", &line]).spawn()
            };
            if r.is_ok() {
                return Ok(());
            }
        }
        return Err("no terminal emulator found".into());
    }
    #[allow(unreachable_code)]
    {
        let _ = shell_quote;
        Err("unsupported platform".into())
    }
}

pub fn open_folder(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    let r = Command::new("explorer").arg(path.replace('/', "\\")).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = Command::new("xdg-open").arg(path).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

pub fn open_editor(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    let r = hidden(Command::new("cmd").args(["/C", "code", path])).spawn();
    #[cfg(not(windows))]
    let r = Command::new("code").arg(path).spawn();
    r.map(|_| ()).map_err(|e| format!("VS Code's `code` command was not found: {e}"))
}
