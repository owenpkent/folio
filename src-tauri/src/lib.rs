//! Folio desktop backend.
//!
//! The Rust side is intentionally thin. It owns the things a sandboxed web
//! frontend cannot do safely on its own: reading files from disk, reporting
//! app metadata, and (in future) native menus, recent-file lists, and secure
//! credential storage for AI providers. All PDF parsing and rendering happens
//! in the frontend via PDF.js. See `docs/architecture.md`.

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use tauri::ipc::Response;

/// True if `ip` is one an outbound `fetch_pdf` must refuse: loopback, private,
/// link-local, carrier-grade NAT, multicast, or otherwise not a globally
/// routable public address. Used to block SSRF against internal services and
/// cloud metadata endpoints (e.g. 169.254.169.254). IPv4-mapped IPv6 addresses
/// are unwrapped and re-checked so `[::ffff:127.0.0.1]` cannot slip through.
fn is_disallowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_unspecified()
                || v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                // 0.0.0.0/8 "this network" (RFC 1122); some stacks route it to
                // loopback. is_unspecified() only matches 0.0.0.0 itself.
                || a == 0
                // 100.64.0.0/10 carrier-grade NAT (RFC 6598).
                || (a == 100 && (b & 0xc0) == 64)
                // 198.18.0.0/15 benchmarking (RFC 2544).
                || (a == 198 && (b & 0xfe) == 18)
                // 240.0.0.0/4 reserved (includes 255.255.255.255).
                || a >= 240
        }
        IpAddr::V6(v6) => {
            // Unwrap both embedded-IPv4 forms and re-check the v4 address:
            // ::ffff:a.b.c.d (mapped) and the deprecated ::a.b.c.d (compatible,
            // segments 0..6 zero, last two the v4). Otherwise ::127.0.0.1 would
            // slip past every check below.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_disallowed_ip(IpAddr::V4(v4));
            }
            let segs = v6.segments();
            if segs[..6].iter().all(|&s| s == 0) && (segs[6] != 0 || segs[7] > 1) {
                return is_disallowed_ip(IpAddr::V4(std::net::Ipv4Addr::new(
                    (segs[6] >> 8) as u8,
                    segs[6] as u8,
                    (segs[7] >> 8) as u8,
                    segs[7] as u8,
                )));
            }
            let first = segs[0];
            v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                // fc00::/7 unique local addresses.
                || (first & 0xfe00) == 0xfc00
                // fe80::/10 link-local.
                || (first & 0xffc0) == 0xfe80
        }
    }
}

/// A ureq [`Resolver`] that always returns a fixed, pre-validated address list
/// and ignores the request URI.
///
/// `fetch_pdf` resolves and vets the target host's IPs itself, then hands them
/// here so ureq connects only to those exact addresses. Without this, ureq's
/// own resolver would run again at connect time and could pick up a different,
/// now-private address in the DNS-rebinding gap between our check and the dial.
///
/// [`Resolver`]: ureq::unversioned::resolver::Resolver
#[derive(Debug)]
struct PinnedResolver(Vec<SocketAddr>);

impl ureq::unversioned::resolver::Resolver for PinnedResolver {
    fn resolve(
        &self,
        _uri: &ureq::http::Uri,
        _config: &ureq::config::Config,
        _timeout: ureq::unversioned::transport::NextTimeout,
    ) -> Result<ureq::unversioned::resolver::ResolvedSocketAddrs, ureq::Error> {
        // `empty()` yields a zero-length ArrayVec; push up to its 16-slot cap.
        let mut result = self.empty();
        for addr in self.0.iter().copied().take(16) {
            result.push(addr);
        }
        if result.is_empty() {
            Err(ureq::Error::HostNotFound)
        } else {
            Ok(result)
        }
    }
}

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
/// Because a `folio://` link can be triggered by any web page, this is treated
/// as hostile input. The URL scheme is checked, then the host is resolved and
/// **every** resulting IP is validated against [`is_disallowed_ip`] to prevent
/// SSRF against loopback/private/link-local/metadata endpoints. The download
/// agent is pinned to those pre-validated IPs (closing the DNS-rebinding window
/// between our check and the connect), follows no redirects (so a public URL
/// cannot 3xx-bounce to an internal host), enforces connect/read timeouts, and
/// caps the response size.
///
/// Cookie-gated PDFs won't work here (there is no browser session on the Rust
/// side) -- that is a documented limitation of the URL hand-off; the in-browser
/// extension viewer covers authenticated PDFs.
#[tauri::command]
async fn fetch_pdf(url: String) -> Result<Response, String> {
    const MAX_BYTES: u64 = 512 * 1024 * 1024; // 512 MB ceiling.
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    const READ_TIMEOUT: Duration = Duration::from_secs(60);

    let parsed = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Unsupported URL scheme: {}", parsed.scheme()));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "URL has no port".to_string())?;

    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        // Resolve the host ourselves so we validate the addresses we will
        // actually connect to (defeats decimal/hex/octal IP encodings and
        // DNS names that point at private space) rather than the URL string.
        let addrs: Vec<SocketAddr> = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| format!("Could not resolve host: {e}"))?
            .collect();
        if addrs.is_empty() {
            return Err("Host did not resolve to any address".into());
        }
        if let Some(bad) = addrs.iter().find(|a| is_disallowed_ip(a.ip())) {
            return Err(format!(
                "Refusing to fetch from a local, private, or reserved address ({})",
                bad.ip()
            ));
        }

        // Pin the connection to the exact addresses we validated via a fixed
        // resolver. Left to itself ureq would re-resolve `host` when connecting,
        // reopening the DNS-rebinding window between our check and the connect.
        let config = ureq::config::Config::builder()
            .max_redirects(0)
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_response(Some(READ_TIMEOUT))
            .timeout_recv_body(Some(READ_TIMEOUT))
            .build();
        let agent = ureq::Agent::with_parts(
            config,
            ureq::unversioned::transport::DefaultConnector::new(),
            PinnedResolver(addrs),
        );

        let mut resp = agent.get(&url).call().map_err(|e| e.to_string())?;
        // max_redirects(0) returns a 3xx rather than following it; reject
        // anything that isn't a success so the viewer never gets a redirect or
        // error body in place of a PDF.
        if !resp.status().is_success() {
            return Err(format!("Server returned HTTP {}", resp.status().as_u16()));
        }
        // limit() caps the body: a response larger than MAX_BYTES errors out
        // rather than being read into memory.
        resp.body_mut()
            .with_config()
            .limit(MAX_BYTES)
            .read_to_vec()
            .map_err(|e| e.to_string())
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
        // Deep-link straight to Folio's page in Default apps (via the
        // RegisteredApplications entry the installer writes), so the user lands
        // on the .pdf association without having to search for it. Falls back to
        // the generic Default apps page on Windows builds that don't honor the
        // query. Fixed URI, no user input -> no injection surface.
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:defaultapps?registeredAppUser=Folio")
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
    use super::{first_pdf_arg, is_disallowed_ip};
    use std::net::IpAddr;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("valid IP literal")
    }

    #[test]
    fn blocks_private_and_reserved_ips() {
        for s in [
            "127.0.0.1",       // loopback
            "10.1.2.3",        // private
            "172.16.0.1",      // private
            "192.168.1.1",     // private
            "169.254.169.254", // link-local / cloud metadata
            "100.64.0.1",      // carrier-grade NAT
            "198.18.0.1",      // benchmarking
            "0.0.0.0",         // unspecified
            "255.255.255.255", // broadcast
            "224.0.0.1",       // multicast
            "0.1.2.3",         // 0.0.0.0/8 "this network"
            "::1",             // IPv6 loopback
            "fc00::1",         // IPv6 unique-local
            "fe80::1",         // IPv6 link-local
            "::ffff:127.0.0.1", // IPv4-mapped loopback
            "::127.0.0.1",     // IPv4-compatible loopback (deprecated)
        ] {
            assert!(is_disallowed_ip(ip(s)), "{s} should be disallowed");
        }
    }

    #[test]
    fn allows_public_ips() {
        for s in ["1.1.1.1", "8.8.8.8", "140.82.112.3", "2606:4700:4700::1111"] {
            assert!(!is_disallowed_ip(ip(s)), "{s} should be allowed");
        }
    }

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
