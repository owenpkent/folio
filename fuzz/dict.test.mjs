import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dictErrors } from './dict.mjs';

const dictDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dict');
const targetDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'targets');

describe('fuzz dictionaries', () => {
  // The nightly fuzz workflow does not run on pull requests, so this is the
  // only check a PR gets that every dictionary still parses.
  const files = readdirSync(dictDir).filter((f) => f.endsWith('.dict'));

  it('has dictionaries to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s parses as a libFuzzer dictionary', (file) => {
    expect(dictErrors(readFileSync(path.join(dictDir, file), 'utf8'))).toEqual([]);
  });

  it.each(files)('%s belongs to a target', (file) => {
    const target = file.replace(/\.dict$/, '');
    expect(readdirSync(targetDir)).toContain(`${target}.fuzz.ts`);
  });
});

describe('dictErrors', () => {
  it('accepts the escapes libFuzzer knows', () => {
    const source = String.raw`# comment

kw="BT"
"bare"
q=" \""
b="a\\b"
x="\x0a\xFF"
`;
    expect(dictErrors(source)).toEqual([]);
  });

  it('rejects any other backslash escape', () => {
    const source = String.raw`ok="a"
esc="(a\)b)"
oct="(\101)"`;
    expect(dictErrors(source)).toEqual([
      { line: 2, text: String.raw`esc="(a\)b)"` },
      { line: 3, text: String.raw`oct="(\101)"` },
    ]);
  });

  it('rejects unquoted, unterminated and empty values', () => {
    expect(dictErrors('kw=BT\nkw="BT\nkw=""\nkw="a" trailing').map((e) => e.line)).toEqual([
      1, 2, 3, 4,
    ]);
  });
});
