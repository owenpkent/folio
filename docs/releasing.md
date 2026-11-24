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

The two signing vars are documented in [`.env.example`](../.env.example) — copy
it to `.env` and load it, or set them inline as above (PowerShell:
`$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\folio.key"`).

Produces, in `src-tauri/target/release/bundle/nsis/`:
- `Folio_<ver>_x64-setup.exe` — EV-signed installer (also the updater payload)
- `Folio_<ver>_x64-setup.exe.sig` — minisign signature for the updater

Omit `--bundles nsis` to also build the MSI (`Folio_<ver>_x64_en-US.msi` +
`.msi.sig`). `createUpdaterArtifacts` is on, so the build **fails loudly** if
`TAURI_SIGNING_PRIVATE_KEY` is unset — that guards against shipping an installer
the updater can't verify. During bundling, `signtool` triggers the SafeNet token
PIN prompt on your desktop; enter it there. `signtool` does not need to be on
`PATH`: `scripts/sign-windows.ps1` falls back to the newest x64 copy in the
Windows 10 SDK.

> [!WARNING]
> The sign script **skips signing quietly when the EV certificate is absent**
> (so CI and dev builds still pass), and the build still succeeds. A release
> built without the token plugged in is unsigned with no error. Always check the
> result before publishing:
> `Get-AuthenticodeSignature <exe> | Format-List Status, SignerCertificate`
> must show `Status: Valid` and `CN=OK Studio Inc.`

> If `CARGO_TARGET_DIR` is set (a redirected Rust output dir), the bundles land
> under `$CARGO_TARGET_DIR/release/bundle/nsis/`, not `src-tauri/target/…`.

#### Check the build runs before publishing

0.9.0 passed every signature, audit and test check and still crashed on every
launch: the bundle inside the installer held two copies of React, which a clean
rebuild of the same commit did not. Two things now stand between a bad bundle
and a release:

- **The build refuses it.** `vite build`, which `tauri build` runs first, fails
  if React, React DOM, scheduler or Zustand is bundled twice, or if any file is
  bundled under two spellings of its path
  ([`scripts/vite/singleCopyGuard.ts`](../scripts/vite/singleCopyGuard.ts)).
  The error lists the paths. Run `npm ci` and build again.
- **You launch it.** Run the exact `folio.exe` the installer carries and confirm
  the start screen appears. Close any running Folio first: the single-instance
  plugin hands a second launch to the copy already running, which would test
  the old version.

  ```powershell
  7z e src-tauri\target\release\bundle\nsis\Folio_<ver>_x64-setup.exe folio.exe -r -o"$env:TEMP\folio-check"
  & "$env:TEMP\folio-check\folio.exe"
  ```

  `target/release/folio.exe` would do as well, but the copy inside the
  installer is the one that ships, and also the only one whose EV signature
  can be checked after the build (Tauri rewrites the other).

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
npm run release:manifest -- --version <ver> --notes "What changed"
# equivalently: node scripts/generate-latest.mjs --version <ver> --notes "What changed"
```

Writes `release/latest.json` with the `windows-x86_64` entry (the `.sig` contents
+ the GitHub download URL the updater fetches). The script reads the `.sig`
sidecar from the bundle output, so step 2 must have produced it.

### 3b. Generate SBOMs (recommended)

Ship a CycloneDX Software Bill of Materials per release so downstream users can
audit what's inside the binary. Folio has two dependency graphs:

```bash
npm run release:sbom   # writes both SBOMs into release/sbom/ (Folio_<ver>_sbom.{npm,cargo}.cyclonedx.json)
```

The Rust side needs `cargo-cyclonedx` (`cargo install cargo-cyclonedx` once); the npm
side runs `@cyclonedx/cyclonedx-npm` via `npx` with no install.

Attach both to the GitHub release in step 4 so the SBOM travels with the binary.
`release/sbom/` keeps every earlier version's SBOMs too, so attach this
version's two files by name, not the whole directory.

### 4. Publish the GitHub Release

The updater endpoint is pinned to the **main repo's** latest release
(`tauri.conf.json → plugins.updater.endpoints`):
`https://github.com/owenpkent/folio/releases/latest/download/latest.json`
(Folio publishes to its own repo — there is no separate releases repo.)

Create it as a **draft** first, verify, then publish:

```bash
git tag v<ver> && git push origin v<ver>
gh release create v<ver> --draft --verify-tag \
  --title "Folio <ver>" \
  --notes-file <notes.md> \
  "src-tauri/target/release/bundle/nsis/Folio_<ver>_x64-setup.exe" \
  release/latest.json \
  release/sbom/Folio_<ver>_sbom.npm.cyclonedx.json \
  release/sbom/Folio_<ver>_sbom.cargo.cyclonedx.json
```

Write the notes from the CHANGELOG section for `<ver>`. If an earlier version
was cut in the CHANGELOG but never published (0.8.0 was; 0.8.1 shipped it),
users are coming from the last *published* release, so include that section
too. Any change that breaks something for an existing user (a file format no
longer read, a setting removed) gets an upgrade note at the top.

Before publishing, download the draft's installer and `latest.json` back
(`gh release download v<ver> -D <dir>`) and compare them with the local files
(SHA-256 for the installer, byte-for-byte for the manifest).

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

### When the app itself fails

That check runs from the root `App` component and talks to the user through the
app's own toasts and dialogs, so a build that fails to render never runs it.
0.9.0 crashed on launch and could not update itself; everyone on it had to
install 0.9.1 by hand.

From 0.9.1 the crash screen ("Folio hit an unexpected error") checks once by
itself and, when a newer version is published, offers **Update to X and
restart**. It goes through `src/features/updates/crashUpdate.ts`, which uses
only the updater and process plugins and no app state, so it does not depend on
whatever broke. A failed install is reported on the same screen, with a pointer
to the releases page.

It cannot help a build that fails before React renders the crash screen: a
script that does not load, or a throw in `main.tsx` before `createRoot`. The
launch check above is what catches those.

### The restart puts the document back

That relaunch is one Folio asked for, not one the user chose, so it should not
cost them their place. `src/features/updates/resumeAfterUpdate.ts` records the
open document's path and current page immediately before `relaunch()`, and
`registerFileOpen` (`src/features/fileopen/openFromLaunch.ts`) reopens both on
the way back up.

Four rules make it a resume rather than a surprise:

- **Only on "Restart now."** Choosing "Later" records nothing. That update lands
  on some future launch the user started for their own reasons, possibly days
  on, and reopening the document they had then is not a convenience. On
  Windows, accepting the update *is* that choice: `tauri-plugin-updater` hands
  the NSIS installer the job of restarting Folio and exits the process from
  inside `install`, so there is no later prompt and nothing after that call
  runs. The update is therefore downloaded first with nothing recorded (the
  window stays usable through the download, and a note taken before it would
  reopen a document closed or swapped out in the meantime, or on a launch
  after an ordinary quit mid-download), and the note is written right before
  `install`, from whatever is open at that moment. An edit made during the
  download gets its own warning before the installer runs. On the platforms
  where `install` returns, the note is written only once "Restart now" is
  chosen, and a failed install leaves none. (0.7.0 to 0.8.1 wrote it after
  the install, which on Windows is never.)
- **Only for documents that came from disk.** `documentStore.sourcePath` is null
  for a file picked in the browser or fetched through a `folio://` link (bytes
  with no on-disk origin), and there is nothing to reopen. Nothing is recorded
  in that case, and any earlier note is cleared, so a restart with nothing open
  does not restore the document before last.
- **Consumed once**, the way the Rust side's `take_launch_file` is: the note
  describes one restart, not a standing preference, so it is cleared on the next
  launch whether or not it is used. A path that fails to open therefore fails
  once rather than on every launch after.
- **A file from the OS wins.** If the relaunch also carries a launch file
  (double-click, single-instance forward), that is what opens: the user picked
  it just now, where the note only records what happened to be open before.

The note lives in `localStorage`, which survives an in-place update because the
installer replaces the binary and not the WebView user-data directory. That is
the same guarantee the theme preference already relies on. It is validated on
read rather than trusted, so a half-written entry reads as "no note".

This is deliberately *not* a general session restore or a recent-files list;
both are still planned Rust-side work (see
[architecture.md](architecture.md)).

## Known limits

- **macOS / Linux** — Folio compiles on all three in CI (`--no-bundle`), but only
  Windows is signed and distributed. There is no `latest.json` entry for other
  platforms yet.
- **`.msi` auto-update** — the NSIS `-setup.exe` is the updater artifact. Users
  who installed via the MSI update by re-installing, not through the in-app
  updater.
