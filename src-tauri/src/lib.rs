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

/// Holds the PDF path Folio was launched with (e.g. by double-clicking a file
/// once Folio is the default viewer). Populated at startup from the process
/// arguments and consumed once by the frontend via [`take_launch_file`].
struct LaunchFile(std::sync::Mutex<Option<String>>);

/// Find the first `.pdf` file among launch arguments.
///
/// When Folio is the default handler, the OS passes the file path as a plain
/// argument. `argv[0]` is the executable, so it is skipped; the path must end
/// in `.pdf` (case-insensitive) and exist on disk to be accepted. This runs on
/// untrusted-ish input (whatever the shell hands us), hence the existence check
/// rather than blindly forwarding a string to the frontend.
fn first_pdf_arg<I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter()
        .skip(1)
        .find(|arg| arg.to_lowercase().ends_with(".pdf") && std::path::Path::new(arg).is_file())
}

/// Return (and clear) the PDF path Folio was launched with, if any.
///
/// Consume-once: the frontend calls this exactly once on startup, so a later
/// in-app reload does not silently re-open the original launch file.
#[tauri::command]
fn take_launch_file(state: tauri::State<LaunchFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut guard| guard.take())
}

/// Open the OS "Default apps" settings so the user can make Folio the default
/// PDF viewer.
///
/// Modern Windows does not let an application seize a default file handler
/// silently, so the best we can do is deep-link to the settings page. The URI
/// is a fixed constant (no user input is interpolated), so there is no command
/// injection surface here.
#[tauri::command]
fn open_default_apps_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:defaultapps")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open Settings: {e}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Setting the default PDF viewer from Folio is only supported on Windows. \
             Set it in your system settings or file manager instead."
            .to_string())
    }
}

/// Application entry point, shared by the desktop `main.rs` and mobile targets.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // single-instance MUST be the first plugin registered. Desktop-only; the
    // deep-link feature routes folio:// URLs from a second launch into the
    // running instance. The callback focuses the existing window and, if the
    // second launch carried a PDF path (e.g. double-clicking another file while
    // Folio is open), forwards it to the running window rather than starting a
    // new instance.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::{Emitter, Manager};
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                if let Some(pdf) = first_pdf_arg(argv) {
                    let _ = window.emit("folio:open-pdf", pdf);
                }
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

    // Cold start: capture a PDF passed on the command line before the window
    // exists. single-instance only fires its callback for *subsequent* launches,
    // so the first instance must read its own argv here.
    let launch_file = first_pdf_arg(std::env::args().collect::<Vec<_>>());

    let app = builder
        .manage(LaunchFile(std::sync::Mutex::new(launch_file)))
        .invoke_handler(tauri::generate_handler![
            read_document,
            write_document,
            fetch_pdf,
            app_version,
            take_launch_file,
            open_default_apps_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Folio application");

    app.run(|_app_handle, _event| {
        // macOS delivers "Open with" files as an Opened run event, not via argv.
        // Untested: this environment cannot build for macOS.
        #[cfg(target_os = "macos")]
        {
            use tauri::{Emitter, Manager};
            if let tauri::RunEvent::Opened { urls } = _event {
                if let Some(window) = _app_handle.get_webview_window("main") {
                    for url in urls {
                        if let Ok(path) = url.to_file_path() {
                            let is_pdf = path
                                .extension()
                                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"));
                            if is_pdf {
                                let _ =
                                    window.emit("folio:open-pdf", path.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::first_pdf_arg;

    #[test]
    fn skips_argv0_and_rejects_non_pdf() {
        // argv[0] (the executable) is skipped, and a non-.pdf argument is ignored.
        let args = vec!["folio.exe".to_string(), "notes.txt".to_string()];
        assert_eq!(first_pdf_arg(args), None);
    }

    #[test]
    fn rejects_pdf_that_does_not_exist() {
        let args = vec![
            "folio.exe".to_string(),
            "definitely-missing-file.pdf".to_string(),
        ];
        assert_eq!(first_pdf_arg(args), None);
    }

    #[test]
    fn finds_existing_pdf_case_insensitive() {
        // A real file with an uppercase .PDF extension is accepted. Namespaced by
        // pid so concurrent test binaries do not collide on the temp path.
        let path = std::env::temp_dir().join(format!("folio_launch_{}.PDF", std::process::id()));
        std::fs::write(&path, b"%PDF-1.4\n").expect("write temp pdf");
        let expected = path.to_string_lossy().to_string();
        let args = vec!["folio.exe".to_string(), expected.clone()];
        assert_eq!(first_pdf_arg(args), Some(expected));
        let _ = std::fs::remove_file(&path);
    }
}
