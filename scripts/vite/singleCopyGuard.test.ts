import { describe, expect, it } from 'vitest';

import { findDuplicateModules, moduleFile, normalizeModuleId } from './singleCopyGuard';

const root = 'W:/dev/folio/node_modules';

describe('findDuplicateModules', () => {
  it('passes a bundle with one copy of everything', () => {
    const ids = [
      `${root}/react/index.js`,
      `${root}/react/cjs/react.production.js`,
      `${root}/react-dom/client.js`,
      `${root}/zustand/esm/react.mjs`,
      'W:/dev/folio/src/main.tsx',
      '\0vite/preload-helper.js',
    ];
    expect(findDuplicateModules(ids, true)).toEqual([]);
  });

  // The suspected 0.9.0 failure: one file reached as w:\ and as W:\.
  it('refuses one file under two spellings of its path on a case-insensitive disk', () => {
    const problems = findDuplicateModules(
      [`${root}/react/index.js`, 'w:\\dev\\folio\\node_modules\\react\\index.js'],
      true,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^one file under 2 paths/);
  });

  // The bundler keys modules by id, so the prefixed and plain spellings of one
  // file are two modules even where case matters.
  it('refuses a verbatim \\\\?\\ path next to the plain one', () => {
    const problems = findDuplicateModules(
      [`${root}/react/index.js`, '\\\\?\\W:\\dev\\folio\\node_modules\\react\\index.js'],
      false,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^one file under 2 paths/);
  });

  it('cuts the query after a verbatim prefix, whose own ? is not one', () => {
    expect(moduleFile('\\\\?\\W:\\a\\b.js?v=1')).toBe('\\\\?\\W:\\a\\b.js');
    expect(normalizeModuleId('\\\\?\\W:\\a\\b.js?v=1')).toBe('W:/a/b.js');
    expect(normalizeModuleId('\0W:/a/b.js?worker')).toBe('W:/a/b.js');
  });

  it('allows one file loaded as two modules on purpose, by query', () => {
    const worker = `${root}/pdfjs-dist/legacy/build/pdf.worker.min.mjs`;
    expect(findDuplicateModules([worker, `${worker}?url`], true)).toEqual([]);
  });

  it('treats paths that differ only in case as two files where case matters', () => {
    const ids = ['/srv/app/node_modules/x/A.js', '/srv/app/node_modules/x/a.js'];
    expect(findDuplicateModules(ids, false)).toEqual([]);
    expect(findDuplicateModules(ids, true)).toHaveLength(1);
  });

  it('refuses React, React DOM, scheduler or Zustand installed in two places', () => {
    const problems = findDuplicateModules(
      [
        `${root}/react/index.js`,
        `${root}/some-lib/node_modules/react/index.js`,
        `${root}/zustand/esm/react.mjs`,
        `${root}/@scope/ui/node_modules/zustand/esm/react.mjs`,
      ],
      true,
    );
    expect(problems).toEqual([
      expect.stringMatching(/^react from 2 places/),
      expect.stringMatching(/^zustand from 2 places/),
    ]);
  });

  it('allows two copies of a package that is not required to be single', () => {
    const ids = [`${root}/lodash/index.js`, `${root}/other/node_modules/lodash/index.js`];
    expect(findDuplicateModules(ids, true)).toEqual([]);
  });
});
