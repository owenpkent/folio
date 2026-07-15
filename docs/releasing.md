# Releasing Folio (Windows)

How Folio cuts a release: the EV-signed NSIS installer and the `latest.json`
manifest consumed by `tauri-plugin-updater` for auto-update.

> **Before running any step below, work through
> [release-checklist.md](release-checklist.md).** That is the preflight gate
> (tests, signing, Dependabot status, doc updates, smoke test). The steps here
> are only the mechanics; the checklist decides whether the release should
> happen at all.

Two independent signatures are involved:

| Signature | Purpose | Key | Where |
| --- | --- | --- | --- |
| **EV Authenticode** | Windows trust / SmartScreen / verified publisher | OK Studio Inc. EV cert on a SafeNet eToken (thumbprint `fc22b522…`) | `scripts/sign-windows.ps1` via `bundle.windows.signCommand` |
| **minisign** | Update authenticity (`tauri-plugin-updater` verifies each update) | `~/.tauri/folio.key` (private) / pubkey (key ID `95E10389C64A7469`) in `tauri.conf.json` | `TAURI_SIGNING_PRIVATE_KEY` env at build time |

Windows is **built locally**, not in CI: both keys live only on the release
host, and the correct ordering (`build → EV-sign → minisign`) requires both
signing steps in the **same `tauri build` invocation`** (see [Why one
invocation](#why-one-invocation)). CI compiles with `--no-bundle` (no cert/key
needed). Folio distributes Windows only; macOS/Linux bundles are not part of the
release flow today.

> [!IMPORTANT]
> The updater signing key (`~/.tauri/folio.key`) is password-protected and lives
> only on the release host. Keep the key file **and** its password in a password
> manager: if either is lost you can no longer ship updates that existing installs
> will accept. To rotate it, run
> `npx tauri signer generate -w $HOME/.tauri/folio.key --force`, then replace
> `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` with the new public key.

## Steps

### 1. Bump the version

Keep these four in sync, and use the value as the git tag (`v<ver>`):

- `package.json` → `version`
- `src-tauri/tauri.conf.json` → `version`
- `src-tauri/Cargo.toml` → `version`
- `src-tauri/Cargo.lock` → the `[[package]] name = "folio"` entry (run
  `cargo metadata --no-deps` or a build to confirm it is in sync)

Then cut [CHANGELOG.md](../CHANGELOG.md): move the `## [Unreleased]` items under
a new `## [<ver>] - YYYY-MM-DD` heading, add a fresh empty `## [Unreleased]`, and
add the compare-link references at the bottom.

### 2. Build + sign (non-elevated shell, eToken plugged in)

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/folio.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<your key password>'
npx tauri build --bundles nsis
```

Produces, in `src-tauri/target/release/bundle/nsis/`:
- `Folio_<ver>_x64-setup.exe` — EV-signed installer (also the updater payload)
- `Folio_<ver>_x64-setup.exe.sig` — minisign signature for the updater

Omit `--bundles nsis` to also build the MSI (`Folio_<ver>_x64_en-US.msi` +
`.msi.sig`). `createUpdaterArtifacts` is on, so the build **fails loudly** if
`TAURI_SIGNING_PRIVATE_KEY` is unset — that guards against shipping an installer
the updater can't verify. During bundling, `signtool` triggers the SafeNet token
PIN prompt on your desktop; enter it there.

> If `CARGO_TARGET_DIR` is set (a redirected Rust output dir), the bundles land
> under `$CARGO_TARGET_DIR/release/bundle/nsis/`, not `src-tauri/target/…`.

#### Why one invocation

The `.sig` must be computed over the **EV-signed** bytes. Tauri's bundler runs
`signCommand` (EV) first, then generates the minisign `.sig` — so a single
`tauri build` gets the order right. If you EV-sign *after* generating the `.sig`
(e.g. a bolt-on `tauri signer sign` before EV signing), the `.exe` bytes change
and the published `.sig` no longer matches, silently breaking auto-update. Do
not split the two signatures across steps.

#### EV-only fallback (no updater artifacts)

If you must cut an **installable** build without the minisign password — and no
existing clients would verify a `.sig` yet — you can ship an EV-signed installer
without updater artifacts:

```bash
npx tauri build --bundles nsis --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

Only the eToken PIN prompts; no minisign password needed. The installer is still
EV-signed and fully installable, but there is **no `.sig`**, so **omit
`latest.json`** when publishing (a manifest with an empty signature is rejected
by clients). Trade-off: installs from this build cannot auto-update until a
*later* release ships with a valid `.sig` — so the **next** release must set both
env vars and include `latest.json`.

### 3. Generate the update manifest

```bash
node scripts/generate-latest.mjs --version <ver> --notes "What changed"
```

Writes `release/latest.json` with the `windows-x86_64` entry (the `.sig` contents
+ the GitHub download URL the updater fetches). The script reads the `.sig`
sidecar from the bundle output, so step 2 must have produced it.

### 3b. Generate SBOMs (recommended)

Ship a CycloneDX Software Bill of Materials per release so downstream users can
audit what's inside the binary. Folio has two dependency graphs:

```bash
# renderer (production deps only)
npx @cyclonedx/cyclonedx-npm --omit dev --output-file release/sbom/Folio_<ver>_sbom.npm.cyclonedx.json
# backend (every crate compiled in); needs `cargo install cargo-cyclonedx` once
cargo cyclonedx --manifest-path src-tauri/Cargo.toml --format json
```

Attach both to the GitHub release in step 4 so the SBOM travels with the binary.

### 4. Publish the GitHub Release

The updater endpoint is pinned to the **main repo's** latest release
(`tauri.conf.json → plugins.updater.endpoints`):
`https://github.com/owenpkent/folio/releases/latest/download/latest.json`
(Folio publishes to its own repo — there is no separate releases repo.)

Create it as a **draft** first, verify, then publish:

```bash
git tag v<ver> && git push origin v<ver>
gh release create v<ver> --draft \
  --title "Folio <ver>" \
  --notes "See CHANGELOG" \
  "src-tauri/target/release/bundle/nsis/Folio_<ver>_x64-setup.exe" \
  release/latest.json \
  release/sbom/*
```

`latest.json` **must** be attached so
`.../releases/latest/download/latest.json` resolves. Then walk
[release-checklist.md](release-checklist.md) §6 (post-build verify) and click
**Publish** on the draft. Existing installs check the manifest on launch and
offer the update.

> **SmartScreen:** new releases may show a "Windows protected your PC" prompt
> until download reputation builds — this is expected, not a signing failure
> (Microsoft removed the EV fast-pass in 2024). The installer is signed by
> **OK Studio Inc.**; click **More info → Run anyway**.

## How the in-app update works

On launch (desktop only), `src/features/updates/checkForUpdates.ts` calls the
updater, and if a newer version is published it prompts the user, downloads +
installs, and offers to relaunch. Per-user install (`%LOCALAPPDATA%\Folio`) means
updates apply **without a UAC prompt**.

## Known limits

- **macOS / Linux** — Folio compiles on all three in CI (`--no-bundle`), but only
  Windows is signed and distributed. There is no `latest.json` entry for other
  platforms yet.
- **`.msi` auto-update** — the NSIS `-setup.exe` is the updater artifact. Users
  who installed via the MSI update by re-installing, not through the in-app
  updater.
