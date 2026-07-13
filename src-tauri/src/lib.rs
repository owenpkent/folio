//! Folio desktop backend.
//!
//! The Rust side is intentionally thin. It owns the things a sandboxed web
//! frontend cannot do safely on its own: reading files from disk, reporting
//! app metadata, and (in future) native menus, recent-file lists, and secure
//! credential storage for AI providers. All PDF parsing and rendering happens
//! in the frontend via PDF.js. See `docs/architecture.md`.

use tauri::ipc::Response;

/// Read a PDF from disk and hand its raw bytes to the frontend.
///
/// Returning a [`Response`] (instead of `Vec<u8>`) ships the payload as a raw
/// binary body that JavaScript receives as an `ArrayBuffer`. This avoids
/// serialising a multi-megabyte PDF into a JSON array of numbers.
#[tauri::command]
fn read_document(path: String) -> Result<Response, String> {
    if !path.to_lowercase().ends_with(".pdf") {
        return Err(format!("Unsupported file type (expected .pdf): {path}"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    Ok(Response::new(bytes))
}

/// Write PDF bytes to an absolute path chosen via the native save dialog.
///
/// Lives on the Rust side (mirroring [`read_document`]) so the frontend does
/// not need a broad `fs:allow-write-file` capability scope to save a copy
/// wherever the user picks. The `.pdf` extension guard matches `read_document`.
#[tauri::command]
fn write_document(path: String, contents: Vec<u8>) -> Result<(), String> {
    if !path.to_lowercase().ends_with(".pdf") {
        return Err(format!("Unsupported file type (expected .pdf): {path}"));
    }
    std::fs::write(&path, &contents).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Return the running application version, sourced from `Cargo.toml`.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Application entry point, shared by the desktop `main.rs` and mobile targets.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![read_document, write_document, app_version])
        .run(tauri::generate_context!())
        .expect("error while running the Folio application");
}
