# Releasing Folio (Windows)

Folio ships as an **EV-signed NSIS installer** with a built-in **auto-updater**.
Two independent signatures are involved:

| Signature | Purpose | Key | Where |
| --- | --- | --- | --- |
| **EV Authenticode** | Windows trust / SmartScreen / verified publisher | OK Studio Inc. EV cert on a SafeNet eToken (thumbprint `fc22b522…`) | `scripts/sign-windows.ps1` via `bundle.windows.signCommand` |
| **minisign** | Update authenticity (`tauri-plugin-updater` verifies each update) | `~/.tauri/folio.key` (private) / pubkey in `tauri.conf.json` | `TAURI_SIGNING_PRIVATE_KEY` env at build time |

Windows is **built locally**, not in CI: both keys live only on the release host.
CI compiles with `--no-bundle` (no cert/key needed).

> [!IMPORTANT]
> The updater signing key (`~/.tauri/folio.key`) is password-protected and lives
> only on the release host. Keep the key file **and** its password in a password
> manager: if either is lost you can no longer ship updates that existing installs
> will accept. To rotate it, run
> `npx tauri signer generate -w $HOME/.tauri/folio.key --force`, then replace
> `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` with the new public key.

## Steps

### 1. Bump the version

Keep these three in sync:
- `package.json` → `version`
- `src-tauri/tauri.conf.json` → `version`
- `src-tauri/Cargo.toml` → `version`

### 2. Build + sign (non-elevated shell, eToken plugged in)

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/folio.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<your key password, or empty>'
npx tauri build --bundles nsis
```

Produces, in `src-tauri/target/release/bundle/nsis/`:
- `Folio_<ver>_x64-setup.exe` — EV-signed installer (also the updater payload)
- `Folio_<ver>_x64-setup.exe.sig` — minisign signature for the updater

(Omit `--bundles nsis` to also build the MSI. `createUpdaterArtifacts` is on, so
the build **fails loudly** if `TAURI_SIGNING_PRIVATE_KEY` is unset — that guards
against shipping an installer the updater can't verify.)

### 3. Generate the update manifest

```bash
node scripts/generate-latest.mjs --version <ver> --notes "What changed"
```

Writes `release/latest.json` with the `windows-x86_64` entry (signature + the
GitHub download URL the updater will fetch).

### 4. Publish the GitHub Release

The updater endpoint is pinned to the **main repo's** latest release
(`tauri.conf.json → plugins.updater.endpoints`):
`https://github.com/owenpkent/folio/releases/latest/download/latest.json`

```bash
git tag v<ver> && git push origin v<ver>
gh release create v<ver> \
  "src-tauri/target/release/bundle/nsis/Folio_<ver>_x64-setup.exe" \
  release/latest.json \
  --title "Folio <ver>" \
  --notes "See CHANGELOG"
```

`latest.json` **must** be attached to the release so
`.../releases/latest/download/latest.json` resolves. Existing installs check it
on launch and offer the update.

> **SmartScreen:** new releases may show a "Windows protected your PC" prompt
> until download reputation builds — this is expected, not a signing failure
> (Microsoft removed the EV fast-pass in 2024). The installer is signed by
> **OK Studio Inc.**; click **More info → Run anyway**.

## How the in-app update works

On launch (desktop only), `src/features/updates/checkForUpdates.ts` calls the
updater, and if a newer version is published it prompts the user, downloads +
installs, and offers to relaunch. Per-user install (`%LOCALAPPDATA%\Folio`) means
updates apply **without a UAC prompt**.
