import { describe, expect, it } from 'vitest';

import { isRegression, mergeBaseline, type Status } from './baseline';

describe('isRegression', () => {
  // [was, now, regression?]
  const table: [Status | undefined, Status, boolean][] = [
    // Nothing recorded: nothing to regress from.
    [undefined, 'save-threw', false],
    [undefined, 'ok', false],
    // Unchanged status is never a regression, whatever it is.
    ['ok', 'ok', false],
    ['refused', 'refused', false],
    ['save-threw', 'save-threw', false],
    ['timeout', 'timeout', false],
    // A file that worked and no longer does.
    ['ok', 'save-threw', true],
    ['ok', 'refused', true],
    ['ok', 'text-changed', true],
    ['ok', 'timeout', true],
    // A clean refusal that turned into a crash or bad output.
    ['refused', 'save-threw', true],
    ['refused', 'bake-reopen-failed', true],
    ['refused', 'timeout', true],
    // Getting better is not a regression.
    ['refused', 'ok', false],
    ['save-threw', 'ok', false],
    ['save-threw', 'refused', false],
    // One kind of failure becoming another is noise, not a regression.
    ['save-threw', 'reopen-failed', false],
    ['timeout', 'save-threw', false],
    // skip-* describes the input, so it is never compared in either direction.
    ['ok', 'skip-unreadable', false],
    ['refused', 'skip-encrypted', false],
    ['skip-unreadable', 'save-threw', false],
    ['skip-encrypted', 'ok', false],
  ];

  it.each(table)('%s -> %s is regression: %s', (was, now, expected) => {
    expect(isRegression(was, now)).toBe(expected);
  });
});

describe('mergeBaseline', () => {
  const existing = { 'b.pdf': 'ok', 'a.pdf': 'ok', 'c.pdf': 'refused' } as const;

  it('keeps untested entries when the run was partial', () => {
    const out = mergeBaseline(existing, [{ file: 'a.pdf', status: 'save-threw' }], {
      partial: true,
    });
    expect(out).toEqual({ 'a.pdf': 'save-threw', 'b.pdf': 'ok', 'c.pdf': 'refused' });
  });

  it('adds a new file on a partial run without touching the rest', () => {
    const out = mergeBaseline(existing, [{ file: 'd.pdf', status: 'ok' }], { partial: true });
    expect(Object.keys(out)).toEqual(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']);
  });

  it('replaces the baseline on a full run, dropping files that left the corpus', () => {
    const out = mergeBaseline(
      existing,
      [
        { file: 'b.pdf', status: 'ok' },
        { file: 'a.pdf', status: 'ok' },
      ],
      { partial: false },
    );
    expect(out).toEqual({ 'a.pdf': 'ok', 'b.pdf': 'ok' });
  });

  it('sorts keys so the committed file diffs cleanly', () => {
    const out = mergeBaseline(
      {},
      [
        { file: 'z.pdf', status: 'ok' },
        { file: 'm.pdf', status: 'ok' },
        { file: 'a.pdf', status: 'ok' },
      ],
      { partial: false },
    );
    expect(Object.keys(out)).toEqual(['a.pdf', 'm.pdf', 'z.pdf']);
  });

  it('does not mutate the existing baseline', () => {
    const before = { ...existing };
    mergeBaseline(existing, [{ file: 'a.pdf', status: 'timeout' }], { partial: true });
    expect(existing).toEqual(before);
  });
});
