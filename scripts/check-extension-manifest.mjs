#!/usr/bin/env node
/**
 * Guards the Chrome extension's permission surface against silent drift.
 *
 * Every entry below has to be justified, one by one, in the Chrome Web Store
 * listing, and `<all_urls>` is what puts the submission into in-depth review.
 * A permission added in passing is easy to miss in a diff and expensive to
 * discover at review time, so widening the surface has to be a deliberate edit
 * to this file rather than a side effect of an edit to the manifest.
 *
 * Narrowing matters too: a permission the extension no longer uses is a
 * rejection reason on its own.
 *
 * Run via `npm run check:extension` or as a CI step. Exits 0 when the manifest
 * matches, 1 on drift, 2 if the manifest can't be parsed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The approved surface. Changing this is the point at which someone thinks. */
const EXPECTED = {
  permissions: ['contextMenus', 'declarativeNetRequest', 'storage', 'tabs'],
  host_permissions: ['<all_urls>'],
  // Only the entry point needs to be reachable from a web origin: the redirect
  // navigates the tab there, and the page's own assets are then same-origin.
  web_accessible_resources: ['dist/index.html'],
};

function fail(code, lines) {
  console.error(lines.join('\n'));
  process.exit(code);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(resolve(ROOT, 'extensions/chrome/manifest.json'), 'utf8'));
} catch (err) {
  fail(2, [`Could not read extensions/chrome/manifest.json: ${err.message}`]);
}

const actual = {
  permissions: manifest.permissions ?? [],
  host_permissions: manifest.host_permissions ?? [],
  web_accessible_resources: (manifest.web_accessible_resources ?? []).flatMap((e) => e.resources ?? []),
};

const problems = [];
for (const [key, expected] of Object.entries(EXPECTED)) {
  const added = actual[key].filter((v) => !expected.includes(v));
  const removed = expected.filter((v) => !actual[key].includes(v));
  for (const v of added) problems.push(`  + ${key}: ${v}   (added, not yet approved)`);
  for (const v of removed) problems.push(`  - ${key}: ${v}   (removed, still listed as approved)`);
}

// The service worker is a module, and the CSP allows wasm because pdf.js and
// tesseract need it. Both are load-bearing enough to be worth asserting.
if (manifest.background?.type !== 'module') {
  problems.push('  background.type is not "module"; the worker uses ES imports');
}
if (!manifest.content_security_policy?.extension_pages?.includes("script-src 'self'")) {
  problems.push("  extension_pages CSP no longer pins script-src to 'self'");
}

if (problems.length) {
  fail(1, [
    'Chrome extension manifest drifted from the approved surface:',
    '',
    ...problems,
    '',
    'If the change is intended, update EXPECTED in scripts/check-extension-manifest.mjs',
    'and the permission justification table in the store listing. Those two go together:',
    'a permission the listing does not justify is a rejection.',
  ]);
}

console.log('Chrome extension manifest OK: permission surface unchanged.');
