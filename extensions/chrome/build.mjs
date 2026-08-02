// Build the Folio Chrome extension into a loadable, packable directory.
//
//   node extensions/chrome/build.mjs            # stage build/
//   node extensions/chrome/build.mjs --zip      # stage build/ and pack the .zip
//   node extensions/chrome/build.mjs --no-ocr   # stage without the OCR runtime
//
// Output goes to extensions/chrome/build/, NOT to this directory. Load that as
// the unpacked extension. Staging separately is what lets the build own the
// manifest version and drop files that should not ship, without those edits
// showing up as churn in the checked-in source.
//
// Note for anyone testing from a script: branded Chrome has ignored
// --load-extension since Chrome 137. Use the Load unpacked button, or Chromium
// / Chrome for Testing.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { zipSync } from './zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const out = resolve(here, 'build');

const args = new Set(process.argv.slice(2));
const wantZip = args.has('--zip');
const withOcr = !args.has('--no-ocr');

/** Extension source that ships as-is. Anything not listed here does not ship. */
const SOURCE_FILES = [
  'background.js',
  'rules.js',
  'settings.js',
  'storage.js',
  'options.html',
  'options.js',
  'options.css',
];

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));

// --- 1. Build the web app ---------------------------------------------------
// Relative base so index.html references ./assets/... , which resolve under
// chrome-extension://<id>/dist/ (an absolute /assets/ would 404).
//
// SOURCE_DATE_EPOCH pins the build timestamp vite bakes into the bundle for the
// About dialog. Without it two builds of the same commit differ, and the .zip
// below is reproducible in principle but never in practice. Defaulting it to
// the commit's own timestamp keeps the displayed date meaningful while making
// the package a function of the commit.
function sourceDateEpoch() {
  if (process.env.SOURCE_DATE_EPOCH) return process.env.SOURCE_DATE_EPOCH;
  try {
    return execSync('git log -1 --format=%ct', { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return ''; // Not a git checkout. Fall back to wall-clock, and say so.
  }
}

const epoch = sourceDateEpoch();
console.log(`Building Folio ${pkg.version} (relative base) ...`);
if (!epoch) console.log('  no commit timestamp available; output will not be reproducible');
execSync('npm run build -- --base=./', {
  cwd: repo,
  stdio: 'inherit',
  env: { ...process.env, ...(epoch ? { SOURCE_DATE_EPOCH: epoch } : {}) },
});

// --- 2. Stage ---------------------------------------------------------------
console.log('Staging extension into extensions/chrome/build ...');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const file of SOURCE_FILES) {
  cpSync(join(here, file), join(out, file));
}

// The manifest version is derived, never hand-edited. scripts/check-extension-version.mjs
// keeps the checked-in copy honest so the repo does not claim a version it will
// not ship.
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// Icons: whatever sizes the desktop app already has. The store wants 16/32/48/128.
mkdirSync(join(out, 'icons'), { recursive: true });
const ICON_SOURCES = { 16: '32x32.png', 32: '32x32.png', 48: '128x128.png', 128: '128x128.png' };
const iconsHave = [];
for (const [size, source] of Object.entries(ICON_SOURCES)) {
  const from = join(repo, 'src-tauri', 'icons', source);
  if (!existsSync(from)) continue;
  cpSync(from, join(out, 'icons', `icon-${size}.png`));
  iconsHave.push(size);
}
manifest.icons = Object.fromEntries(iconsHave.map((s) => [s, `icons/icon-${s}.png`]));
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// The viewer. Source maps are development artefacts: they roughly double the
// payload and hand a reviewer 5 MB of noise to scan.
cpSync(join(repo, 'dist'), join(out, 'dist'), {
  recursive: true,
  filter: (src) => {
    if (src.endsWith('.map')) return false;
    if (!withOcr && src.includes(`${'tesseract'}`)) return false;
    return true;
  },
});

// --- 3. Report --------------------------------------------------------------
function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const files = walk(out);
const sizeOf = (paths) => paths.reduce((n, f) => n + statSync(f).size, 0);
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

const ocrFiles = files.filter((f) => f.includes('tesseract'));
const total = sizeOf(files);

console.log('\nPayload:');
console.log(`  total            ${mb(total)}  (${files.length} files)`);
if (ocrFiles.length) {
  console.log(`  of which OCR     ${mb(sizeOf(ocrFiles))}  (--no-ocr drops it)`);
}
console.log(`  icons            ${iconsHave.join(', ') || 'none'}`);

// --- 4. Pack ----------------------------------------------------------------
if (wantZip) {
  const zipPath = join(here, `folio-chrome-${pkg.version}.zip`);
  const entries = files.map((f) => ({
    name: relative(out, f),
    data: readFileSync(f),
  }));
  const buf = zipSync(entries);
  writeFileSync(zipPath, buf);
  console.log(`\nPacked ${relative(repo, zipPath)}  (${mb(buf.length)})`);
  console.log(
    epoch
      ? `Reproducible: rebuilding this commit gives the same bytes (SOURCE_DATE_EPOCH=${epoch}).`
      : 'NOT reproducible: no commit timestamp, so the bundle carries a wall-clock date.',
  );
}

console.log('\nLoad extensions/chrome/build as an unpacked extension in chrome://extensions.');
