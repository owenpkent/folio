# Release preflight checklist

Copy this into the GitHub release issue and tick items off as you go. The
mechanics (bundle commands, manifest generation, publish steps) live in
[releasing.md](releasing.md) — this checklist is the **gate** that decides
whether those steps should run.

Every item is **required to ship** unless marked optional. If you skip one,
write the reason in the release issue (not in this file). Skipping the
signature checks or the Dependabot gate is **not** acceptable — fix the
issue or defer the release.

---

## 1. Code quality (must pass)

- [ ] `npm run test` — Vitest suite green
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` — Rust unit tests green
- [ ] `npm run lint` — no ESLint errors
- [ ] `npm run typecheck` — no type errors
- [ ] `npm run check:versions` — `tauri` crate and `@tauri-apps/api` share the same major.minor (also enforced in CI)
- [ ] `npm audit`: no high/critical
- [ ] `cargo audit --manifest-path src-tauri/Cargo.toml`: **zero vulnerabilities**. The
      standing warning count is unmaintained/unsound advisories on transitive crates,
      most of them Tauri's Linux GTK stack, which Windows builds never compile. Treat a
      *new* warning as worth reading and any actual vulnerability as blocking
- [ ] `npm run build` — clean production build, no warnings worth investigating
- [ ] `npm run test:e2e` — Playwright smoke suite green (needs `npx playwright install chromium`, and again after any `@playwright/test` upgrade, or every spec fails at 0ms on a missing browser)
- [ ] No outstanding **High** or **Critical** Dependabot alerts on `main`
      (`gh api repos/owenpkent/folio/dependabot/alerts --jq '.[] | select(.state=="open") | select(.security_advisory.severity=="high" or .security_advisory.severity=="critical")'`).
      Document any accepted Medium/Low alerts in the CHANGELOG.
- [ ] Working tree clean (`git status`), `main` is the branch being released

---

## 2. Documentation

- [ ] `CHANGELOG.md` — `## [Unreleased]` items moved under a `## [<ver>] - YYYY-MM-DD`
      heading with a fresh empty `## [Unreleased]` above, and the compare links updated
- [ ] Versions match across `package.json`, `src-tauri/tauri.conf.json`,
      `src-tauri/Cargo.toml`, `extensions/chrome/manifest.json`, and the `folio`
      entry in `src-tauri/Cargo.lock` -- and match the planned tag `v<ver>`
      (`npm run check:extension` covers the manifest)
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
- [ ] `release/latest.json` `signature` for `windows-x86_64` matches the contents of `Folio_<ver>_x64-setup.exe.sig`, and `pub_date` is the current UTC time
- [ ] File association survived the build. Tauri regenerates the NSIS script on
  every build, and nothing fails if the hook stops being applied, so check
  that the hook actually made it into the generated script before checking
  what it wrote:
  ```powershell
  rg -c "NSIS_HOOK_POSTINSTALL" "src-tauri\target\release\nsis\x64\installer.nsi"   # prints a count; empty means the hook did not survive regeneration
  rg -cF "installer.nsh" "src-tauri\target\release\nsis\x64\installer.nsi"          # prints a count; empty means installerHooks is not wired
  ```
  Then install the bundle and confirm the keys [`src-tauri/installer.nsh`](../src-tauri/installer.nsh) writes are present:
  ```powershell
  (Get-Item "HKCU:\Software\Classes\.pdf\OpenWithProgids" -ErrorAction SilentlyContinue).Property                    # includes "PDF Document"
  (Get-ItemProperty "HKCU:\Software\Classes\Applications\folio.exe" -ErrorAction SilentlyContinue).FriendlyAppName    # "Folio"
  (Get-ItemProperty "HKCU:\Software\Classes\PDF Document\Application" -ErrorAction SilentlyContinue).ApplicationName  # "Folio"
  (Get-ItemProperty "HKCU:\Software\RegisteredApplications" -ErrorAction SilentlyContinue).Folio                     # "Software\Folio\Capabilities"
  ```
  This only proves anything after an explicit uninstall, or on a clean VM or
  user profile. Reinstalling the same version over an existing Folio install
  lands on the installer's "Add/Reinstall" page, which skips the uninstaller
  entirely, so all four of these survive from the previous install even if
  the hook silently stopped being applied.

  Then right-click any `.pdf` → *Open with* → *Choose another app*: **Folio** is listed, under that name. See `docs/testing.md` → *Default PDF viewer*.

- [ ] Uninstalling while Folio holds the `.pdf` default does not strand
  Windows on "How do you want to open this file?" forever. This is the one
  check in this section that `docs/testing.md`'s *Uninstall cleanup* item
  does not cover: that item confirms the registry keys are gone, not what
  Explorer actually does once they are. It also only reproduces on a machine
  or VM where Folio has actually *held* the default -- `NSIS_HOOK_POSTUNINSTALL`
  in `src-tauri/installer.nsh` only deletes the per-user `UserChoice` key
  when its `ProgId` is Folio's, so an install that never became the default
  has nothing there to delete, and the check proves nothing.

  On such a machine: install the build, right-click a `.pdf` → *Open with* →
  *Choose another app* → pick Folio → **Always**, uninstall Folio, then
  double-click a `.pdf`. Confirm the "How do you want to open this file?"
  prompt does not reappear on every click from then on, and that the reader
  that was the default before Folio (or a single fresh prompt, if there was
  none) takes over instead.

---

## 4. Distribution / infra

- [ ] EV signing certificate not expiring within 30 days (check the cert's "Valid to" field)
- [ ] `tauri.conf.json → plugins.updater.pubkey` (key ID `95E10389C64A7469`) matches the private key used to sign the `.sig` (otherwise installed clients reject the update)
- [ ] SBOMs generated (`release/sbom/`) if shipping them this release
- [ ] GitHub release **draft** prepared with notes derived from the CHANGELOG; do not publish yet

### Chrome extension (only if shipping an extension update this release)

- [ ] `npm run check:extension`: manifest version matches `package.json` and the
      permission surface has not drifted
- [ ] `npm run package:chrome`: builds `extensions/chrome/folio-chrome-<ver>.zip`
- [ ] Loaded unpacked from `extensions/chrome/build` in **branded** Chrome and smoke
      tested by hand: a `.pdf` URL and a content-type-only PDF both open in the viewer,
      the options page saves, and the toolbar button tracks the tab. None of this is
      covered by CI, and `--load-extension` does not work in branded Chrome
- [ ] If any permission changed: the store listing's justification table updated to match,
      in the same change. A permission the listing does not justify is a rejection
- [ ] `docs/browser-extension-privacy.md` still accurate for anything new that stores or
      transmits data. An inaccurate disclosure is grounds for removal after publishing

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
UI changes so screenshots not refreshed." Skipping signature checks or the
Dependabot gate is not acceptable.
