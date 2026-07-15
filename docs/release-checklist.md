# Release preflight checklist

Copy this into the GitHub release issue and tick items off as you go. The
mechanics (bundle commands, manifest generation, publish steps) live in
[releasing.md](releasing.md) — this checklist is the **gate** that decides
whether those steps should run.

Every item is **required to ship** unless marked optional. If you skip one,
write the reason in the release issue (not in this file). Skipping the smoke
test, signature checks, or the Dependabot gate is **not** acceptable — fix the
issue or defer the release.

---

## 1. Code quality (must pass)

- [ ] `npm run test` — Vitest suite green
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` — Rust unit tests green
- [ ] `npm run lint` — no ESLint errors
- [ ] `npm run typecheck` — no type errors
- [ ] `npm run build` — clean production build, no warnings worth investigating
- [ ] `npm run test:e2e` — Playwright smoke suite green (needs `npx playwright install chromium` once)
- [ ] No outstanding **High** or **Critical** Dependabot alerts on `main`
      (`gh api repos/owenpkent/folio/dependabot/alerts --jq '.[] | select(.state=="open") | select(.security_advisory.severity=="high" or .security_advisory.severity=="critical")'`).
      Document any accepted Medium/Low alerts in the CHANGELOG.
- [ ] Working tree clean (`git status`), `main` is the branch being released

---

## 2. Documentation

- [ ] `CHANGELOG.md` — `## [Unreleased]` items moved under a `## [<ver>] - YYYY-MM-DD`
      heading with a fresh empty `## [Unreleased]` above, and the compare links updated
- [ ] Versions match across `package.json`, `src-tauri/tauri.conf.json`,
      `src-tauri/Cargo.toml`, and the `folio` entry in `src-tauri/Cargo.lock` — and
      match the planned tag `v<ver>`
- [ ] `ROADMAP.md` — rows that shipped this cycle flipped to Done
- [ ] README — feature list still accurate, screenshots not stale
- [ ] Feature docs updated where behavior changed (e.g. `docs/editing-and-ocr.md`,
      `docs/forms-and-signatures.md`)
- [ ] If breaking changes for end users: an upgrade note in the GitHub release body

---

## 3. Windows build verification (required)

Windows is built **locally** on the EV-cert host, not in CI. CI's `windows-latest`
runner has no EV hardware token, and the correct ordering is `build → EV-sign →
minisign` — if EV-signing happens after the `.sig` is generated, the `.exe` bytes
change and the published `.sig` no longer matches, breaking auto-update. Tauri
enforces the order via `bundle.windows.signCommand` on a host with the token
plugged in (see [releasing.md → Why one invocation](releasing.md#why-one-invocation)).

On the EV-cert Windows host:

- [ ] `bundle.windows.signCommand` invokes `scripts/sign-windows.ps1` (filters vendor DLLs, retries on Defender file locks)
- [ ] `signtool.exe` is on `PATH` for the build shell — typically `C:\Program Files (x86)\Windows Kits\10\bin\<latest>\x64`. Verify with `Get-Command signtool.exe`.
- [ ] `npx tauri build` produces `Folio_<ver>_x64-setup.exe` and a matching `Folio_<ver>_x64-setup.exe.sig` in `src-tauri/target/release/bundle/nsis/`. Sidecars only appear when `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` are set; if missing, the build **fails** because `bundle.createUpdaterArtifacts` is `true`.
- [ ] EV signature is valid: `Get-AuthenticodeSignature <exe> | Format-List Status, SignerCertificate` shows `Status: Valid`, signer `CN=OK Studio Inc.` (or `signtool verify /pa /v <exe>`)
- [ ] **Clean-VM smoke test** on a Windows 11 VM with no prior Folio install:
  - [ ] NSIS installer runs end-to-end; installs per-user to `%LOCALAPPDATA%\Folio` with no UAC prompt
  - [ ] App launches and opens a PDF (drag-drop and `Ctrl/Cmd+O`); pages render
  - [ ] Default-viewer: double-clicking a `.pdf` opens it in Folio (cold start renders the file)
  - [ ] Editing: add a text box + image, Save a copy, reopen — both land correctly
  - [ ] OCR: recognize a scanned PDF, select/search text, save, confirm searchable elsewhere (assets load offline)
  - [ ] Auto-update path: install the previous published version first, then verify the in-app updater detects the new version, downloads, and relaunches (point the updater endpoint at a locally-served `release/latest.json` if testing before publish)
- [ ] `release/latest.json` `signature` for `windows-x86_64` matches the contents of `Folio_<ver>_x64-setup.exe.sig`, and `pub_date` is the current UTC time

---

## 4. Distribution / infra

- [ ] EV signing certificate not expiring within 30 days (check the cert's "Valid to" field)
- [ ] `tauri.conf.json → plugins.updater.pubkey` (key ID `95E10389C64A7469`) matches the private key used to sign the `.sig` (otherwise installed clients reject the update)
- [ ] SBOMs generated (`release/sbom/`) if shipping them this release
- [ ] GitHub release **draft** prepared with notes derived from the CHANGELOG; do not publish yet

---

## 5. Tag, publish, verify

Run only after every required item above is ticked. Publishing is local; there is
no release workflow.

- [ ] `git tag v<ver> && git push origin v<ver>`
- [ ] Regenerate the manifest: `node scripts/generate-latest.mjs --version <ver> --notes "…"`
- [ ] `gh release create v<ver> --draft --title "Folio <ver>" src-tauri/target/release/bundle/nsis/Folio_<ver>_x64-setup.exe release/latest.json release/sbom/*`
- [ ] Publish the draft release
- [ ] `curl -I https://github.com/owenpkent/folio/releases/latest/download/latest.json` returns `200` (the URL Tauri's updater hits)
- [ ] One existing-install machine (your own) auto-updates on relaunch and lands on the new version

---

## 6. Post-release watch

- [ ] Watch the repo's Issues / Discussions for install or update failures
- [ ] Re-verify the updater endpoint resolves for a day or two after publish
- [ ] If a regression surfaces, prepare a hotfix branch off the tag rather than
      rolling forward on `main`

---

## Skipping items

Write any skip reason in the GitHub release issue. Common acceptable skips: "no
UI changes so screenshots not refreshed." Skipping smoke tests, signature checks,
or the Dependabot gate is not acceptable.
