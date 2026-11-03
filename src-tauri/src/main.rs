// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod control;
mod engine;
mod managed;
mod model;
mod registry;
mod transcript;

use control::{Decision, Emit, Hub};
use engine::Engine;
use managed::{Managed, StartOpts};
use model::Delta;
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

struct AppState {
    engine: Arc<Mutex<Engine>>,
    hub: Arc<Hub>,
    managed: Arc<Managed>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlInfo {
    hooks_installed: bool,
    port: Option<u16>,
    approval_mode: String,
    approval_secs: u64,
    machine: String,
    settings_path: String,
    window_hours: f64,
}

fn control_info_of(st: &AppState) -> ControlInfo {
    let cfg = st.hub.config.lock().unwrap().clone();
    let eng = st.engine.lock().unwrap();
    ControlInfo {
        hooks_installed: control::hooks_installed(),
        port: *st.hub.port.lock().unwrap(),
        approval_mode: cfg.approval_mode,
        approval_secs: cfg.approval_secs,
        machine: eng.machine(),
        settings_path: registry::claude_root()
            .join("settings.json")
            .to_string_lossy()
            .to_string(),
        window_hours: eng.window_hours,
    }
}

#[tauri::command]
fn get_snapshot(st: State<AppState>) -> Delta {
    let running = st.managed.running();
    st.engine.lock().unwrap().tick(&st.hub, &running, true)
}

#[tauri::command]
fn control_info(st: State<AppState>) -> ControlInfo {
    control_info_of(&st)
}

#[tauri::command]
fn set_window(st: State<AppState>, hours: f64) {
    st.engine.lock().unwrap().window_hours = hours.clamp(0.25, 24.0 * 30.0);
    st.hub.dirty.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn install_hooks(st: State<AppState>) -> Result<ControlInfo, String> {
    let cfg = st.hub.config.lock().unwrap().clone();
    control::install_hooks(&cfg)?;
    Ok(control_info_of(&st))
}

#[tauri::command]
fn uninstall_hooks(st: State<AppState>) -> Result<ControlInfo, String> {
    control::uninstall_hooks()?;
    Ok(control_info_of(&st))
}

#[tauri::command]
fn set_approval(st: State<AppState>, mode: String, secs: u64) -> ControlInfo {
    {
        let mut cfg = st.hub.config.lock().unwrap();
        if ["monitor_first", "monitor_only", "terminal"].contains(&mode.as_str()) {
            cfg.approval_mode = mode;
        }
        cfg.approval_secs = secs.clamp(5, 590);
        cfg.save();
    }
    control_info_of(&st)
}

/// Deliver a message: straight into a session the monitor runs, queued for the next
/// hook of a live session, or by resuming a closed session under the monitor.
#[tauri::command]
fn send_message(app: AppHandle, st: State<AppState>, session_id: String, text: String, steer: Option<bool>) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("empty message".into());
    }
    if st.managed.is_running(&session_id) {
        st.managed.send(&session_id, &text)?;
        st.hub.dirty.store(true, Ordering::SeqCst);
        return Ok("sent".into());
    }
    let (live, cwd) = {
        let eng = st.engine.lock().unwrap();
        (eng.live_entry(&session_id).is_some(), eng.session_cwd(&session_id))
    };
    if live {
        st.hub.queue_message(&session_id, &text, steer.unwrap_or(false));
        return Ok("queued".into());
    }
    let cwd = cwd.ok_or("unknown session folder")?;
    st.managed.spawn(&emitter(&app), &st.hub, &cwd, Some(&session_id), None, None)?;
    st.managed.send(&session_id, &text)?;
    Ok("resumed".into())
}

#[tauri::command]
fn cancel_message(st: State<AppState>, session_id: String, message_id: String) {
    st.hub.with(&session_id, |c| c.queued.retain(|m| m.id != message_id));
}

#[tauri::command]
fn resolve_permission(st: State<AppState>, session_id: String, allow: bool, message: Option<String>) -> bool {
    let d = if allow {
        Decision::Allow
    } else {
        Decision::Deny(message.unwrap_or_default(), false)
    };
    st.hub.resolve(&session_id, d)
}

#[tauri::command]
fn set_paused(st: State<AppState>, session_id: String, paused: bool) {
    st.hub.with(&session_id, |c| c.paused = paused);
}

#[tauri::command]
fn stop_turn(st: State<AppState>, session_id: String) -> Result<String, String> {
    if st.managed.is_running(&session_id) {
        st.managed.interrupt(&session_id)?;
        return Ok("interrupted".into());
    }
    // A held approval can interrupt right away; otherwise stop at the next hook
    if st.hub.resolve(&session_id, Decision::Deny("Stopped from Claude Session Monitor".into(), true)) {
        return Ok("interrupted".into());
    }
    st.hub.with(&session_id, |c| {
        c.stop_requested = true;
        c.paused = false;
    });
    Ok("stopping".into())
}

#[tauri::command]
fn start_session(app: AppHandle, st: State<AppState>, opts: StartOpts) -> Result<String, String> {
    match opts.mode.as_str() {
        "background" => managed::start_background(&opts),
        "terminal" => {
            let mut args: Vec<&str> = Vec::new();
            if let Some(m) = opts.model.as_deref().filter(|m| !m.is_empty()) {
                args.extend(["--model", m]);
            }
            if let Some(pm) = opts.permission_mode.as_deref().filter(|m| !m.is_empty()) {
                args.extend(["--permission-mode", pm]);
            }
            if let Some(n) = opts.name.as_deref().filter(|n| !n.is_empty()) {
                args.extend(["--name", n]);
            }
            if !opts.prompt.trim().is_empty() {
                args.push(opts.prompt.as_str());
            }
            managed::open_terminal(&opts.cwd, &args).map(|_| "terminal".into())
        }
        _ => {
            let sid = st.managed.spawn(
                &emitter(&app),
                &st.hub,
                &opts.cwd,
                None,
                opts.model.as_deref(),
                opts.permission_mode.as_deref(),
            )?;
            if !opts.prompt.trim().is_empty() {
                st.managed.send(&sid, &opts.prompt)?;
            }
            Ok(sid)
        }
    }
}

/// Re-open a closed session inside the monitor without sending anything yet
#[tauri::command]
fn take_over(app: AppHandle, st: State<AppState>, session_id: String) -> Result<String, String> {
    let (live, cwd) = {
        let eng = st.engine.lock().unwrap();
        (eng.live_entry(&session_id).is_some(), eng.session_cwd(&session_id))
    };
    if live {
        return Err("This session is still open elsewhere. Close it there first, or send messages through hooks.".into());
    }
    let cwd = cwd.ok_or("unknown session folder")?;
    st.managed.spawn(&emitter(&app), &st.hub, &cwd, Some(&session_id), None, None)
}

#[tauri::command]
fn release(st: State<AppState>, session_id: String) -> bool {
    st.managed.kill(&session_id)
}

#[tauri::command]
fn kill_process(st: State<AppState>, pid: u32) -> bool {
    st.engine.lock().unwrap().kill_pid(pid)
}

#[tauri::command]
fn stop_background(name: String) -> Result<(), String> {
    managed::stop_background(&name)
}

/// Open a terminal for a session: attach to a live background session, resume a closed
/// one, or (for a session already open elsewhere) just open a shell in its folder.
#[tauri::command]
fn open_terminal(st: State<AppState>, session_id: Option<String>, cwd: Option<String>) -> Result<(), String> {
    let (live, folder) = match &session_id {
        Some(sid) => {
            let eng = st.engine.lock().unwrap();
            (eng.live_entry(sid), eng.session_cwd(sid))
        }
        None => (None, None),
    };
    let cwd = cwd.or(folder).ok_or("unknown session folder")?;
    match (session_id, live) {
        (Some(_), Some(r)) if r.kind == "background" => {
            let target = r.name.unwrap_or(r.session_id);
            managed::open_terminal(&cwd, &["attach", &target])
        }
        (Some(_), Some(_)) => managed::open_shell(&cwd),
        (Some(sid), None) if !st.managed.is_running(&sid) => managed::open_terminal(&cwd, &["--resume", &sid]),
        _ => managed::open_shell(&cwd),
    }
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    managed::open_folder(&path)
}

#[tauri::command]
fn open_editor(path: String) -> Result<(), String> {
    managed::open_editor(&path)
}

/// Events from the control plane go to the window. A permission request also raises a
/// desktop notification when the monitor is not in front.
fn emitter(app: &AppHandle) -> Emit {
    let app = app.clone();
    Arc::new(move |event: &str, payload: serde_json::Value| {
        if event == "attention" {
            let focused = app
                .get_webview_window("main")
                .and_then(|w| w.is_focused().ok())
                .unwrap_or(false);
            if !focused {
                let tool = payload["tool"].as_str().unwrap_or("a tool");
                let detail = payload["detail"].as_str().unwrap_or("");
                let _ = app
                    .notification()
                    .builder()
                    .title("Claude needs your decision")
                    .body(format!("Wants to run {}: {}", tool, transcript::safe_truncate(detail, 120)))
                    .show();
            }
        }
        let _ = app.emit(event, payload);
    })
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// `--dump`: print one engine pass as JSON and exit (debugging aid)
fn dump() {
    let mut e = Engine::new();
    let hub = Hub::new();
    let d = e.tick(&hub, &Default::default(), true);
    println!("{}", serde_json::to_string(&d).unwrap_or_default());
}

/// Headless emitter for the debug modes: one JSON line per event on stdout
fn stdout_emitter() -> Emit {
    Arc::new(|event: &str, payload: serde_json::Value| {
        println!("EVENT {} {}", event, payload);
    })
}

/// `--serve [--auto-allow] [--inject <text>]`: run only the hook server, printing every
/// event. --auto-allow approves held permission requests after 1.5s; --inject queues a
/// message for each session the first time it reports in.
fn serve(auto_allow: bool, inject: Option<String>, steer: bool) {
    let hub = Arc::new(Hub::new());
    control::start_server(stdout_emitter(), hub.clone());
    std::thread::sleep(Duration::from_millis(200));
    let cfg = hub.config.lock().unwrap().clone();
    println!("READY port={:?} settings={}", hub.port.lock().unwrap(), control::launch_settings(&cfg));
    let mut injected: std::collections::HashSet<String> = Default::default();
    loop {
        std::thread::sleep(Duration::from_millis(250));
        if let Some(text) = &inject {
            let seen: Vec<String> = hub.ctl.lock().unwrap().keys().cloned().collect();
            for sid in seen {
                if injected.insert(sid.clone()) {
                    hub.queue_message(&sid, text, steer);
                    println!("QUEUED for {}", sid);
                }
            }
        }
        if !auto_allow {
            continue;
        }
        let due: Vec<String> = hub
            .ctl
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, c)| c.decision_tx.is_some() && c.pending.as_ref().map(|p| control::now_ms() - p.ts > 1500).unwrap_or(false))
            .map(|(k, _)| k.clone())
            .collect();
        for sid in due {
            println!("AUTO-ALLOW {} -> {}", sid, hub.resolve(&sid, Decision::Allow));
        }
    }
}

/// `--managed-test <cwd>`: drive a stream-json session end to end: send a message,
/// interrupt it mid-answer, then send a second message on the same process.
fn managed_test(cwd: &str) {
    let hub = Arc::new(Hub::new());
    // Skip the user's own settings (their hooks and plugins) so the test has no side effects
    let managed = Managed::with_args(vec!["--setting-sources".into(), "project".into()]);
    let deltas = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let results = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (d2, r2) = (deltas.clone(), results.clone());
    let emit: Emit = Arc::new(move |event: &str, payload: serde_json::Value| {
        let kind = payload["data"]["type"].as_str().unwrap_or("").to_string();
        if kind == "stream_event" {
            if payload["data"]["event"]["delta"]["type"] == "text_delta" {
                d2.fetch_add(1, Ordering::SeqCst);
            }
            return;
        }
        if kind == "result" {
            r2.fetch_add(1, Ordering::SeqCst);
        }
        let s = payload.to_string();
        println!("EVENT {} {}", event, transcript::safe_truncate(&s, 400));
    });
    let sid = managed
        .spawn(&emit, &hub, cwd, None, Some("haiku"), Some("default"))
        .expect("spawn");
    println!("SPAWNED {}", sid);
    managed.send(&sid, "Count from 1 to 200, one number per line, nothing else.").unwrap();
    let start = Instant::now();
    while deltas.load(Ordering::SeqCst) < 5 && start.elapsed() < Duration::from_secs(60) {
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("INTERRUPT after {} deltas -> {:?}", deltas.load(Ordering::SeqCst), managed.interrupt(&sid));
    let start = Instant::now();
    while results.load(Ordering::SeqCst) < 1 && start.elapsed() < Duration::from_secs(30) {
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("FIRST RESULT count={} running={}", results.load(Ordering::SeqCst), managed.is_running(&sid));
    managed.send(&sid, "Reply with exactly one word: pong").unwrap();
    let start = Instant::now();
    while results.load(Ordering::SeqCst) < 2 && start.elapsed() < Duration::from_secs(60) {
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("SECOND RESULT count={}", results.load(Ordering::SeqCst));
    managed.kill_all();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--dump") {
        return dump();
    }
    if args.iter().any(|a| a == "--serve") {
        let inject = args.iter().position(|a| a == "--inject").and_then(|i| args.get(i + 1).cloned());
        return serve(args.iter().any(|a| a == "--auto-allow"), inject, args.iter().any(|a| a == "--steer"));
    }
    if let Some(i) = args.iter().position(|a| a == "--managed-test") {
        return managed_test(args.get(i + 1).map(|s| s.as_str()).unwrap_or("."));
    }
    let engine = Arc::new(Mutex::new(Engine::new()));
    let hub = Arc::new(Hub::new());
    let managed = Arc::new(Managed::default());
    let managed_on_exit = managed.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            engine: engine.clone(),
            hub: hub.clone(),
            managed: managed.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            control_info,
            set_window,
            install_hooks,
            uninstall_hooks,
            set_approval,
            send_message,
            cancel_message,
            resolve_permission,
            set_paused,
            stop_turn,
            start_session,
            take_over,
            release,
            kill_process,
            stop_background,
            open_terminal,
            open_folder,
            open_editor,
        ])
        .setup(move |app| {
            let show = MenuItemBuilder::with_id("show", "Show Window").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Claude Session Monitor")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            control::start_server(emitter(app.handle()), hub.clone());

            // Engine loop: wakes every 200 ms, rebuilds at least once a second and
            // immediately when a hook or managed session marks the hub dirty.
            let (handle, engine, hub, managed) = (app.handle().clone(), engine.clone(), hub.clone(), managed.clone());
            let mut last_tip = String::new();
            std::thread::spawn(move || {
                let mut last = Instant::now() - Duration::from_secs(5);
                loop {
                    std::thread::sleep(Duration::from_millis(200));
                    let dirty = hub.dirty.swap(false, Ordering::SeqCst);
                    if !dirty && last.elapsed() < Duration::from_millis(1000) {
                        continue;
                    }
                    last = Instant::now();
                    let running = managed.running();
                    let (delta, counts) = {
                        let mut eng = engine.lock().unwrap();
                        let d = eng.tick(&hub, &running, false);
                        (d, eng.counts())
                    };
                    let tip = match counts {
                        (0, 0, 0) => "Claude Session Monitor
No live sessions".to_string(),
                        (w, b, y) => format!("Claude Session Monitor
{} working · {} need you · {} your turn", w, b, y),
                    };
                    if tip != last_tip {
                        let _ = tray.set_tooltip(Some(&tip));
                        last_tip = tip;
                    }
                    if !delta.upserts.is_empty() || !delta.removed.is_empty() {
                        let _ = handle.emit("sessions-delta", &delta);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app, event| {
        if let tauri::RunEvent::Exit = event {
            managed_on_exit.kill_all();
        }
    });
}
