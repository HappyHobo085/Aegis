// src-tauri/src/autopilot.rs
// Dev-only autopilot support. Compiled ONLY under debug_assertions, so release
// builds never contain it. The renderer (also dev-only) invokes these directly by
// name — they are NOT part of the production `ipc` dispatcher / IPC contract.
#![cfg(debug_assertions)]

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;

fn out_dir_from(var: Option<String>) -> PathBuf {
    var.map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("aegis-autopilot"))
}

fn out_dir() -> PathBuf {
    out_dir_from(std::env::var("AEGIS_AUTOPILOT_OUT").ok())
}

#[tauri::command]
pub fn autopilot_screenshot(name: String) -> Result<(), String> {
    let dir = out_dir().join("shots");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let path = dir.join(format!("{safe}.png"));
    // Best-effort: spectacle active-window, background mode, no notification.
    // (Linux/KDE-specific; fails gracefully on other platforms.)
    let status = Command::new("spectacle")
        .args(["-b", "-n", "-a", "-o", &path.to_string_lossy()])
        .status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("spectacle exit {s}")),
        Err(e) => Err(format!("spectacle spawn failed: {e}")),
    }
}

#[tauri::command]
pub fn autopilot_write_report(report_json: String, html: String) -> Result<(), String> {
    let dir = out_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("report.json"), report_json).map_err(|e| e.to_string())?;
    fs::write(dir.join("report.html"), html).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn autopilot_done() -> Result<(), String> {
    let dir = out_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("done.sentinel"), b"done").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn autopilot_emit_event(app: AppHandle, name: String, payload: serde_json::Value) {
    // Reuse the production emitter so the `.`->`:` rewrite + delivery match real events.
    crate::emit_event(&app, &name, payload);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn out_dir_honors_env() {
        assert_eq!(
            out_dir_from(Some("/tmp/aegis-ap-test".into())),
            PathBuf::from("/tmp/aegis-ap-test")
        );
        assert_eq!(
            out_dir_from(None),
            std::env::temp_dir().join("aegis-autopilot")
        );
    }
}
