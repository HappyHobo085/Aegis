// Task 8 implements the real WKWebView find here.
use tauri::AppHandle;

pub fn start(_app: &AppHandle, _id: u32, _query: &str, _case_sensitive: bool) {}
pub fn next(_app: &AppHandle, _id: u32) {}
pub fn prev(_app: &AppHandle, _id: u32) {}
pub fn close(_app: &AppHandle, _id: u32) {}
