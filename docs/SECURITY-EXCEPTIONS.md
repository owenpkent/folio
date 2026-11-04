# Security exceptions

Findings from automated security audits that have been reviewed and
knowingly skipped. Each entry records the finding, the reason it
isn't load-bearing for this project's threat model, and the trigger
that would warrant revisiting.

Triage agents should treat entries here as "known skipped, do not
re-flag" rather than as a free pass to ignore the underlying class of
finding.

## Dependabot alert #25: node-forge GHSA-86w9-cpqp-85rv (resolved)

- **Resolved:** 2026-10-07. PR #110 removed `node-forge`; the alert closed as
  fixed the same day. Kept as a record of the reasoning.
- **Finding:** `node-forge` <= 1.4.0 accepts a malformed DigestInfo when
  verifying a PKCS#1 v1.5 signature (GHSA-86w9-cpqp-85rv). There is no
  patched release.
- **Decided:** 2026-10-07. Tolerate until PR #110, which removes
  `node-forge`, merges.
- **Reason:** The flaw is in signature verification, and Folio never
  verifies an RSA signature with `node-forge`. It uses the library only to
  generate keys, self-signed certificates and PKCS#12 bundles, to sign (via
  `@signpdf/signer-p12`), and to parse the CMS envelope for the signer's
  name (`src/features/signing/cert.ts`, `src/features/signing/verify.ts`).
  `rg -n "\.verify\(|verifyCertificateChain" src` finds no call to
  `publicKey.verify`, `certificate.verify` or `pki.verifyCertificateChain`;
  the only hit is a comment in `verify.ts` warning future code not to use
  them.
- **Revisit when:** no longer applies; the dependency is gone.

## cargo audit: zbus 5 helper crates unmaintained (RUSTSEC-2026-0370, -0371, -0372)

- **Finding:** `zvariant` 5.13.0 (RUSTSEC-2026-0370), `zbus_names` 4.3.3
  (RUSTSEC-2026-0371) and `zvariant_derive` 5.13.0 (RUSTSEC-2026-0372) are
  flagged *unmaintained*, an informational warning with no patched version.
  They were not abandoned: their maintainers merged them into `zbus` 6.0.0
  (`zvariant` became its `wire` module), so the fix is moving to `zbus` 6.
- **Decided:** 2026-11-01. Carry the warnings while we pursue option 1 below.
- **Status:** 2026-11-02, option 1 in review upstream as
  [tauri-apps/plugins-workspace#3759](https://github.com/tauri-apps/plugins-workspace/pull/3759),
  awaiting maintainer review. Built and tested on Linux; with the port patched
  into Folio, `cargo build` passes and `cargo audit` no longer reports the three
  IDs. A maintainer said on
  [#3716](https://github.com/tauri-apps/plugins-workspace/issues/3716) they
  would rather move in step with `notify-rust` and `ashpd`, which are still on
  `zbus` 5, so the PR may wait for them. Update this line when it merges and
  ships.
- **Path into Folio:** only `tauri-plugin-single-instance` 2.5.5 depends on
  `zbus` 5, and only on Linux (`cargo tree -i zbus --target all`). Folio ships
  Windows only, so none of this code is built or shipped. `Cargo.lock` resolves
  every target, though, so the crates stay in the lockfile and `cargo audit`
  reports them.
- **Upstream:** #3759 ports the plugin's Linux code to `zbus` 6 and is part of
  [#3716](https://github.com/tauri-apps/plugins-workspace/issues/3716), which
  asks for the move in notification, opener and single-instance.
  [#3722](https://github.com/tauri-apps/plugins-workspace/pull/3722) is a
  Renovate PR, opened 2026-10-20, that bumps the version only, with no review
  and a failed artifact update. No 2.x release is scheduled.
  `tauri-plugin-single-instance` 3.0.0-alpha.3 is not a way out: it requires
  Tauri 3 and still uses `zbus` 5.
- **What the plugin does for Folio (Windows):** a named mutex marks the first
  instance, which also creates a hidden window. A second launch finds that
  window, calls `AllowSetForegroundWindow`, sends its working directory and argv
  by `WM_COPYDATA`, and exits. The `deep-link` feature passes the argv to
  `tauri-plugin-deep-link` first, which is how a `folio://` link from the Chrome
  extension reaches the open window. Folio's callback in `src-tauri/src/lib.rs`
  focuses the window and forwards a PDF path.

### Options

| Option | Effort | Behavior change | Clears the warnings |
|---|---|---|---|
| 1. Port the Linux code to `zbus` 6 upstream and test it (#3759) | Medium, done in Tauri's repo | None | Yes, once a 2.x release ships |
| 2. Vendor the plugin's Windows code into the repo, no-op elsewhere, via `[patch.crates-io]` | Medium: ~150 lines of unsafe Win32 to own, each `unsafe` block needs a safety comment | None if copied faithfully; no single-instance on Linux/macOS | Yes, `zbus` leaves the lockfile |
| 3. Fork the whole plugin on `zbus` 6 via `[patch.crates-io]` (git or path) | Medium; Linux code cannot be tested from Windows | None | Yes |
| 4. Write our own single-instance code from scratch | High, security-sensitive IPC | Risk of focus and forwarding regressions | Yes |
| 5. Remove the plugin | Low | Every opened PDF and `folio://` link opens a new window | Yes |
| 6. Ignore the three IDs in `src-tauri/.cargo/audit.toml`; scope `deny.toml` `[graph] targets` to Windows | Minutes | None | Hidden, not removed |
| 7. Wait | None | None | When upstream ships |

Taking over the three crates is not an option: they were retired by their own
maintainers, not orphaned. Option 1 is the only route that fixes it for every
Tauri app, and it makes options 2 to 6 unnecessary, so it is the one we chose.
If upstream declines or stalls, option 2 is the fallback.

- **Revisit when:** a `tauri-plugin-single-instance` 2.x release depends on
  `zbus` 6 (`cargo update -p tauri-plugin-single-instance`, then
  `cargo tree -i zvariant --target all` comes back empty), or when Folio starts
  shipping a Linux build.

## How to add an exception

Document the finding (rule ID + score), the date the decision was
made, the threat-model reasoning, and the concrete trigger that
would warrant revisiting. "Revisit when" should be observable, not
aspirational: "when X happens" not "eventually."
