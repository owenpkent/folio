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

/// Download a PDF from a public http(s) URL. Used by the browser extension's
/// "Open in Folio" hand-off (`folio://open?url=...`).
///
/// Validates the scheme and refuses local/private hosts to avoid SSRF, and caps
/// the response size. Cookie-gated PDFs won't work here (there is no browser
/// session on the Rust side) -- that is a documented limitation of the URL
/// hand-off; the in-browser extension viewer covers authenticated PDFs.
#[tauri::command]
async fn fetch_pdf(url: String) -> Result<Response, String> {
    const MAX_BYTES: u64 = 512 * 1024 * 1024; // 512 MB ceiling.

    let parsed = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Unsupported URL scheme: {}", parsed.scheme()));
    }
    match parsed.host_str() {
        None => return Err("URL has no host".into()),
        Some(host) => {
            let h = host.to_ascii_lowercase();
            let is_private = h == "localhost"
                || h == "::1"
                || h.starts_with("127.")
                || h.starts_with("10.")
                || h.starts_with("192.168.")
                || h.starts_with("169.254.")
                || (h.starts_with("172.")
                    && h.split('.')
                        .nth(1)
                        .and_then(|o| o.parse::<u8>().ok())
                        .is_some_and(|o| (16..=31).contains(&o)));
            if is_private {
                return Err("Refusing to fetch from a local or private address".into());
            }
        }
    }

    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        use std::io::Read;
        let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        resp.into_reader()
            .take(MAX_BYTES)
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        Ok(buf)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(Response::new(bytes))
}

/// Return the running application version, sourced from `Cargo.toml`.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Application entry point, shared by the desktop `main.rs` and mobile targets.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // single-instance MUST be the first plugin registered. Desktop-only; the
    // deep-link feature routes folio:// URLs from a second launch into the
    // running instance. The callback just focuses the existing window.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init());

    // tauri-plugin-updater only supports desktop targets.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            read_document,
            write_document,
            fetch_pdf,
            app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Folio application");
}
