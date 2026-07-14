#!/usr/bin/env node
/*
 * Generate release/latest.json for tauri-plugin-updater.
 *
 *   node scripts/generate-latest.mjs --version 0.1.0 --notes "What changed"
 *
 * Reads the signed NSIS installer's minisign .sig sidecar from the Tauri
 * bundle output and writes a manifest pointing at the GitHub release download
 * URL. Requires the build to have run with TAURI_SIGNING_PRIVATE_KEY set so
 * the .sig sidecar exists (see docs/build/WINDOWS or the release steps).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const version = arg('version');
if (!version) {
  console.error('Usage: node scripts/generate-latest.mjs --version <x.y.z> [--notes "..."] [--repo owner/name]');
  process.exit(1);
}
const notes = arg('notes', `Folio ${version}`);
const repo = arg('repo', 'owenpkent/folio');

const setup = `Folio_${version}_x64-setup.exe`;
const sigPath = resolve('src-tauri/target/release/bundle/nsis', `${setup}.sig`);
if (!existsSync(sigPath)) {
  console.error(
    `Signature not found: ${sigPath}\n` +
      'Build with TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD if the key has one) set first.',
  );
  process.exit(1);
}

const signature = readFileSync(sigPath, 'utf8').trim();
const url = `https://github.com/${repo}/releases/download/v${version}/${setup}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': { signature, url },
  },
};

mkdirSync(resolve('release'), { recursive: true });
const out = resolve('release/latest.json');
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out} for v${version} (windows-x86_64)`);
