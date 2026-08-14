#!/usr/bin/env node
/**
 * Verifies that the checked-in Chrome extension manifest declares the same
 * version as package.json.
 *
 * The build derives the shipped version from package.json (see
 * extensions/chrome/build.mjs), so a stale manifest never reaches the store.
 * It does reach anyone who loads extensions/chrome unpacked, or reads the file
 * to find out what version this is, which is reason enough not to let the repo
 * state a version it will not ship.
 *
 * Run via `npm run check:versions` or as a CI step. Exits 0 on parity, 1 on
 * mismatch, 2 if either file can't be parsed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

function readJson(relPath) {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, relPath), 'utf8'));
  } catch (err) {
    fail(2, `Could not read ${relPath}: ${err.message}`);
  }
}

const pkgVersion = readJson('package.json').version;
const manifestVersion = readJson('extensions/chrome/manifest.json').version;

if (!pkgVersion) fail(2, 'package.json has no version');
if (!manifestVersion) fail(2, 'extensions/chrome/manifest.json has no version');

if (pkgVersion !== manifestVersion) {
  fail(
    1,
    [
      'Chrome extension version mismatch:',
      `  package.json:                        ${pkgVersion}`,
      `  extensions/chrome/manifest.json:     ${manifestVersion}`,
      '',
      'The extension ships whatever package.json says. Update the manifest to match:',
      `  "version": "${pkgVersion}"`,
    ].join('\n'),
  );
}

console.log(`Chrome extension version parity OK: ${pkgVersion}`);
