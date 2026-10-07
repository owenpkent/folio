// Download the PDFs stored in mozilla/pdf.js test/pdfs into .corpus/pdfjs/
// (gitignored). Not run by CI or `npm test`; see docs/testing.md.
//
// The files are untrusted input of mixed licenses: they are only ever parsed
// by the harness (corpus.harness.test.ts), never executed, and are not
// committed. *.link files in that directory point at external URLs and are
// skipped; only PDFs actually stored in the repo are fetched.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pinned so results are comparable run to run. Bump deliberately.
const PDFJS_SHA = '89b500f5e1d98ed89bb90211e45b28730b2d99ac';
const REPO = 'https://github.com/mozilla/pdf.js.git';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dest = join(root, '.corpus', 'pdfjs');
// Written last, after every file is in place, and checked by the harness. A
// corpus directory without it (an interrupted copy, a full disk) is incomplete
// and is thrown away rather than trusted.
const MARKER = '.complete';

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'inherit' });
}

if (existsSync(dest)) {
  const marker = join(dest, MARKER);
  const have = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
  if (have === PDFJS_SHA) {
    console.log(`${dest} already populated; delete it to refetch.`);
    process.exit(0);
  }
  console.log(
    have === null
      ? `${dest} exists but is incomplete (no ${MARKER}); refetching.`
      : `${dest} holds mozilla/pdf.js@${have}, pin is ${PDFJS_SHA}; refetching.`,
  );
  rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
}

const work = mkdtempSync(join(tmpdir(), 'folio-pdfjs-'));
// Staged next to the destination and renamed into place once complete, so a
// run that dies half way never leaves a directory that looks like a corpus.
const staging = `${dest}.partial`;
try {
  git(work, 'init', '-q');
  git(work, 'remote', 'add', 'origin', REPO);
  git(work, 'config', 'core.sparseCheckout', 'true');
  git(work, 'sparse-checkout', 'set', '--no-cone', '/test/pdfs/*.pdf');
  // Blobless shallow fetch of the pinned commit; blobs for the sparse paths
  // are fetched on checkout.
  git(work, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', PDFJS_SHA);
  git(work, 'checkout', '-q', 'FETCH_HEAD');

  const src = join(work, 'test', 'pdfs');
  rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(staging, { recursive: true });
  let n = 0;
  for (const name of readdirSync(src)) {
    if (!name.toLowerCase().endsWith('.pdf')) continue;
    copyFileSync(join(src, name), join(staging, name));
    n++;
  }
  writeFileSync(join(staging, MARKER), `${PDFJS_SHA}\n`);
  renameSync(staging, dest);
  console.log(`Fetched ${n} PDFs from mozilla/pdf.js@${PDFJS_SHA} into ${dest}`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
}
