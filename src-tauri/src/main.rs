// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sessions;

use sessions::{get_all_sessions, get_session_by_id};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tokio::time::interval;

/// State holding cached sessions
struct AppState {
    sessions: Arc<Mutex<Vec<serde_json::Value>>>,
}

/// Get all sessions (called from frontend)
#[tauri::command]
fn get_sessions(
    active_only: bool,
    hours: f64,
    state: tauri::State<AppState>,
) -> Vec<serde_json::Value> {
    let sessions = get_all_sessions(active_only, hours);
    let mut cached = state.sessions.lock().unwrap();
    *cached = sessions.clone();
    sessions
}

/// Get a specific session by ID
#[tauri::command]
fn get_session(session_id: String) -> serde_json::Value {
    match get_session_by_id(&session_id) {
        Some(s) => s,
        None => serde_json::json!({"error": "Session not found"}),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // When a second instance is launched, show the existing window
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            sessions: Arc::new(Mutex::new(Vec::new())),
        })
        .invoke_handler(tauri::generate_handler![get_sessions, get_session])
        .setup(|app| {
            // System tray
            let show = MenuItemBuilder::with_id("show", "Show Window").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            let _tray = TrayIconBuilder::new()
                .tooltip("Claude Session Monitor")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            let handle = app.handle().clone();

            // Background polling task — emits "sessions-updated" events
            tauri::async_runtime::spawn(async move {
                let mut tick = interval(Duration::from_millis(1500));
                let mut last_hash = String::new();

                loop {
                    tick.tick().await;
                    let sessions = get_all_sessions(false, 4.0);

                    // Simple change detection: hash file sizes + statuses
                    let current_hash: String = sessions
                        .iter()
                        .take(20)
                        .map(|s| {
                            format!(
                                "{}:{}:{}",
                                s.get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(""),
                                s.get("file_size")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0),
                                s.get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(""),
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("|");

                    if current_hash != last_hash {
                        last_hash = current_hash;
                        let _ = handle.emit("sessions-updated", &sessions);
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
