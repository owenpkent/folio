#!/usr/bin/env node
/**
 * generate-sbom.mjs - produce CycloneDX SBOMs for both dependency trees.
 *
 * Folio ships two dependency graphs: the React renderer (npm) and the
 * Rust/Tauri backend (cargo). A complete Software Bill of Materials needs
 * both. This writes version-stamped CycloneDX JSON into release/sbom/ so the
 * files can be attached to the matching GitHub release (the "SBOM travels
 * with the binary" strategy):
 *
 *   release/sbom/Folio_<ver>_sbom.npm.cyclonedx.json    (renderer, prod deps)
 *   release/sbom/Folio_<ver>_sbom.cargo.cyclonedx.json  (Rust backend)
 *
 * The npm side runs @cyclonedx/cyclonedx-npm via npx (nothing to install) and
 * omits devDependencies, since only production deps end up in the shipped
 * renderer bundle. The Rust side uses cargo-cyclonedx, which lists every crate
 * compiled into the binary. Install it once with:
 *
 *   cargo install cargo-cyclonedx
 *
 * release/ is gitignored, so these outputs are release artifacts, not
 * committed source. Re-run per release.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const ver = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
// `ver` is the only value interpolated into a shell command below (via the
// output filename). Validate it as strict semver so no shell metacharacter can
// ever reach the command string, even from a tampered package.json. The npx
// call must go through a shell (npx resolves to npx.cmd on Windows), so a
// validated input is the right mitigation rather than execFile without a shell.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(ver)) {
  console.error(
    `[sbom] refusing to run: package.json version is not strict semver: ${JSON.stringify(ver)}`,
  );
  process.exit(1);
}
const outDir = join(root, 'release', 'sbom');
mkdirSync(outDir, { recursive: true });

const npmOut = join(outDir, `Folio_${ver}_sbom.npm.cyclonedx.json`);
const cargoOut = join(outDir, `Folio_${ver}_sbom.cargo.cyclonedx.json`);

console.log(`[sbom] Folio ${ver}`);

// 1) npm renderer: production deps only (devDeps don't ship in the bundle).
console.log('[sbom] generating npm SBOM (prod deps)...');
execSync(
  `npx --yes @cyclonedx/cyclonedx-npm@latest --omit dev --output-format JSON --output-file "${npmOut}"`,
  { stdio: 'inherit', cwd: root },
);

// 2) Rust backend: every crate compiled into the binary.
console.log('[sbom] generating cargo SBOM...');
const tauriDir = join(root, 'src-tauri');
try {
  execSync('cargo cyclonedx --manifest-path src-tauri/Cargo.toml --format json', {
    stdio: 'inherit',
    cwd: root,
  });
} catch {
  console.error('[sbom] cargo-cyclonedx failed. Install it with: cargo install cargo-cyclonedx');
  process.exit(1);
}
// cargo-cyclonedx writes <crate>.cdx.json next to the manifest; relocate it.
const produced = readdirSync(tauriDir).filter((f) => f.endsWith('.cdx.json'));
if (produced.length === 0) {
  console.error('[sbom] cargo-cyclonedx produced no .cdx.json');
  process.exit(1);
}
if (existsSync(cargoOut)) unlinkSync(cargoOut);
renameSync(join(tauriDir, produced[0]), cargoOut);

console.log('[sbom] done:');
console.log(`  ${npmOut}`);
console.log(`  ${cargoOut}`);
console.log('[sbom] attach both to the GitHub release for this version.');
