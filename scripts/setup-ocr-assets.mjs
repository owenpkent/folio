// Populate public/tesseract/ with the self-hosted OCR runtime so Folio can run
// tesseract.js fully offline and under the app's strict CSP (no CDN at runtime).
//
// - worker + wasm core are copied from the pinned `tesseract.js` /
//   `tesseract.js-core` npm packages (already in node_modules).
// - the English model (`eng.traineddata.gz`) is fetched once from the tesseract.js
//   maintainers' data host and cached locally.
//
// These assets are large and derived, so they are git-ignored (see .gitignore);
// this script runs automatically via the `predev` / `prebuild` npm hooks. Run it
// by hand with `npm run setup:ocr`. Idempotent: existing files are left alone.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'tesseract');

// Pinned English model (fast/integer LSTM), gzip-compressed as tesseract.js expects.
// Source: the tesseract.js maintainers' data host (fetched at setup time only).
const MODEL_URL = 'https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz';

// SHA-256 of the pinned model (the gzip file exactly as served by MODEL_URL).
// Verified after download (and on cached copies) so a tampered, truncated, or
// MITM'd file never lands in public/tesseract/. Update this whenever MODEL_URL is
// repointed to a different model version.
//
// Provenance: the naptha host mirrors github.com/tesseract-ocr/tessdata_fast.
// Decompressing this .gz yields the authoritative eng.traineddata from tag 4.0.0
// (raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.0.0/eng.traineddata)
// byte-for-byte: 4,113,088 bytes, inner-payload
// sha256 7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2.
const MODEL_SHA256 = '18c1ac52b75e35d44735fb6c2a60acfaf23033524653200738e98f0243edb75b';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Resolve a file shipped inside an installed package. */
function fromPackage(pkg, ...segments) {
  // require.resolve finds the package's entry; walk up to its root, then join.
  const pkgJson = require.resolve(`${pkg}/package.json`);
  return join(dirname(pkgJson), ...segments);
}

function copyIfNeeded(src, destName) {
  const dest = join(outDir, destName);
  if (existsSync(dest)) return;
  if (!existsSync(src)) {
    throw new Error(
      `Missing ${src}. Run \`npm install\` first (tesseract.js / tesseract.js-core).`,
    );
  }
  copyFileSync(src, dest);
  console.log(`[ocr] copied ${destName}`);
}

async function fetchModelIfNeeded() {
  const dest = join(outDir, 'eng.traineddata.gz');
  if (existsSync(dest)) {
    if (sha256(readFileSync(dest)) === MODEL_SHA256) return;
    console.warn('[ocr] cached model failed integrity check; re-downloading');
  }
  console.log(`[ocr] downloading eng.traineddata.gz ...`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Failed to download model: HTTP ${res.status} from ${MODEL_URL}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== MODEL_SHA256) {
    throw new Error(
      `Model integrity check failed for ${MODEL_URL}: expected ${MODEL_SHA256}, got ${digest}. ` +
        'Refusing to write the file.',
    );
  }
  writeFileSync(dest, bytes);
  console.log(`[ocr] saved eng.traineddata.gz (sha256 verified)`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  // The single-instance worker script.
  copyIfNeeded(fromPackage('tesseract.js', 'dist', 'worker.min.js'), 'worker.min.js');

  // The SIMD LSTM core: the .wasm.js glue we point `corePath` at, plus the .wasm
  // binary it loads. Forcing this variant (a .js corePath) bypasses tesseract.js's
  // SIMD auto-detection; baseline wasm SIMD is supported by WebView2 and modern
  // browsers, Folio's only targets.
  copyIfNeeded(
    fromPackage('tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js'),
    'tesseract-core-simd-lstm.wasm.js',
  );
  copyIfNeeded(
    fromPackage('tesseract.js-core', 'tesseract-core-simd-lstm.wasm'),
    'tesseract-core-simd-lstm.wasm',
  );

  await fetchModelIfNeeded();
  console.log('[ocr] assets ready in public/tesseract/');
}

main().catch((err) => {
  console.error(`[ocr] setup failed: ${err.message}`);
  process.exit(1);
});
