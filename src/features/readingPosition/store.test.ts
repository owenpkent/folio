import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { idAlias, normalisePath, pathAlias, type PositionKeys } from './aliases';
import { findPosition, MAX_ENTRIES, setReadingPosition, type ReadingPosition } from './store';

const KEY = 'folio.readingPositions';
const fp = (n: number) => n.toString(16).padStart(64, '0');
const keys = (n: number, idKey: string | null = null, pathKey: string | null = null) =>
  ({ fingerprint: fp(n), idKey, pathKey }) satisfies PositionKeys;
const at = (page: number, extra: Partial<ReadingPosition> = {}): ReadingPosition => ({
  page,
  scale: 1.2,
  fitMode: 'width',
  ...extra,
});
const pageOf = (n: number) => findPosition(keys(n), 1000)?.page ?? null;

const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null');

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('reading position store', () => {
  it('round-trips page and zoom under the fingerprint, with a timestamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    setReadingPosition(keys(1), at(47, { scale: 2, fitMode: 'custom' }));
    expect(findPosition(keys(1), 100)).toEqual({
      page: 47,
      scale: 2,
      fitMode: 'custom',
      via: 'hash',
    });
    expect(findPosition(keys(2), 100)).toBeNull();
    expect(stored()).toEqual({
      v: 1,
      entries: { [fp(1)]: { page: 47, scale: 2, fitMode: 'custom', at: 1234 } },
    });
  });

  it('deletes the entry at page 1 with the default fit, keeps it at another zoom', () => {
    setReadingPosition(keys(1), at(9));
    setReadingPosition(keys(2), at(4));
    setReadingPosition(keys(1), at(1));
    expect(pageOf(1)).toBeNull();
    expect(pageOf(2)).toBe(4);

    setReadingPosition(keys(3), at(1, { scale: 3, fitMode: 'custom' }));
    expect(findPosition(keys(3), 10)).toMatchObject({ page: 1, scale: 3, fitMode: 'custom' });
    setReadingPosition(keys(4), at(1, { fitMode: 'page' }));
    expect(pageOf(4)).toBe(1);
  });

  it('ignores a fingerprint, page, scale or fit mode that could not come from the viewer', () => {
    setReadingPosition({ ...keys(1), fingerprint: 'not-a-hash' }, at(5));
    setReadingPosition(keys(1), at(0));
    setReadingPosition(keys(1), at(2.5));
    setReadingPosition(keys(1), at(2, { scale: Number.NaN }));
    setReadingPosition(keys(1), at(2, { fitMode: 'bogus' as never }));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    ['not json', '{{'],
    ['a string root', '"x"'],
    ['an array root', '[]'],
    ['a wrong version', JSON.stringify({ v: 2, entries: { [fp(1)]: { ...at(3), at: 1 } } })],
    ['entries as an array', JSON.stringify({ v: 1, entries: [] })],
    ['entries missing', JSON.stringify({ v: 1 })],
  ])('treats %s as empty without throwing', (_name, raw) => {
    localStorage.setItem(KEY, raw);
    expect(pageOf(1)).toBeNull();
    setReadingPosition(keys(1), at(3));
    expect(pageOf(1)).toBe(3);
  });

  it('drops bad entries one by one and keeps the good one', () => {
    const good = { page: 8, scale: 1, fitMode: 'width', at: 5 };
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: {
          [fp(1)]: good,
          [fp(2)]: { ...good, page: 0 },
          [fp(3)]: { ...good, page: 1.5 },
          [fp(4)]: { ...good, page: '7' },
          [fp(5)]: { ...good, at: null },
          [fp(6)]: null,
          [fp(7)]: { ...good, scale: 'big' },
          [fp(8)]: { ...good, fitMode: 'sideways' },
          'C:\\secret.pdf': good,
          ABC: good,
        },
      }),
    );
    expect(pageOf(1)).toBe(8);
    for (const n of [2, 3, 4, 5, 6, 7, 8]) expect(pageOf(n)).toBeNull();
    setReadingPosition(keys(9), at(2));
    expect(Object.keys(stored().entries).sort()).toEqual([fp(1), fp(9)].sort());
  });

  it('clamps a stored scale through the viewer clamp', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: { [fp(1)]: { page: 2, scale: 1e9, fitMode: 'custom', at: 1 } },
      }),
    );
    expect(findPosition(keys(1), 10)?.scale).toBe(8);
  });

  it('keeps the newest entries when over the cap', () => {
    const now = vi.spyOn(Date, 'now');
    for (let i = 1; i <= MAX_ENTRIES + 3; i++) {
      now.mockReturnValue(i);
      setReadingPosition(keys(i), at(2));
    }
    const kept = Object.keys(stored().entries);
    expect(kept).toHaveLength(MAX_ENTRIES);
    for (let i = 1; i <= 3; i++) expect(kept).not.toContain(fp(i));
    expect(kept).toContain(fp(MAX_ENTRIES + 3));
  });

  it('swallows storage failures on read and write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => setReadingPosition(keys(1), at(4))).not.toThrow();
    expect(pageOf(1)).toBeNull();
  });
});

describe('alias lookup', () => {
  const ID = fp(0xa1);
  const OTHER_ID = fp(0xa2);
  const PATH = fp(0xb1);

  it('matches the exact hash first, then the newest id, then the newest path', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1);
    setReadingPosition(keys(1, ID, PATH), at(10));
    now.mockReturnValue(2);
    setReadingPosition(keys(2, ID, PATH), at(20));
    now.mockReturnValue(3);
    setReadingPosition(keys(3, OTHER_ID, PATH), at(30));

    expect(findPosition(keys(2, OTHER_ID, PATH), 100)).toMatchObject({ page: 20, via: 'hash' });
    expect(findPosition(keys(9, ID, null), 100)).toMatchObject({ page: 20, via: 'id' });
    expect(findPosition(keys(9, ID, PATH), 100)).toMatchObject({ page: 20, via: 'id' });
    expect(findPosition(keys(9, fp(0xff), PATH), 100)).toMatchObject({ page: 30, via: 'path' });
    expect(findPosition(keys(9, fp(0xff), fp(0xfe)), 100)).toBeNull();
  });

  it('ignores a match past the end of the document', () => {
    setReadingPosition(keys(1, ID, PATH), at(50));
    expect(findPosition(keys(9, ID, PATH), 49)).toBeNull();
    expect(findPosition(keys(1), 49)).toBeNull();
    expect(findPosition(keys(9, ID, PATH), 50)?.page).toBe(50);
  });

  it('drops a malformed alias but keeps the entry', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: { [fp(1)]: { ...at(6), at: 1, id: 'C:\\docs\\a.pdf', path: 42 } },
      }),
    );
    expect(pageOf(1)).toBe(6);
    setReadingPosition(keys(2), at(3));
    expect(stored().entries[fp(1)].id).toBeUndefined();
    expect(stored().entries[fp(1)].path).toBeUndefined();
  });

  it('page 1 at the default fit stops an older copy being resumed through an alias', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1);
    setReadingPosition(keys(1, ID, PATH), at(40));
    setReadingPosition(keys(2, fp(0xcc), fp(0xdd)), at(5));
    now.mockReturnValue(2);
    setReadingPosition(keys(3, ID, PATH), at(1));
    // Not this copy, and not a later re-save or replacement found by an alias:
    // the newest thing known about that id and that path is "back at the top".
    expect(findPosition(keys(3, ID, PATH), 100)).toBeNull();
    expect(findPosition(keys(9, ID, null), 100)).toBeNull();
    expect(findPosition(keys(9, fp(0xff), PATH), 100)).toBeNull();
    expect(pageOf(2)).toBe(5);
  });

  // Independently filled copies of one template: different bytes, different
  // paths, the same trailer /ID. Each has its own place.
  it('page 1 at the default fit leaves another document that shares the trailer id alone', () => {
    const PATH_A = fp(0xb1);
    const PATH_B = fp(0xb2);
    setReadingPosition(keys(1, ID, PATH_A), at(40));
    setReadingPosition(keys(2, ID, PATH_B), at(7));
    setReadingPosition(keys(2, ID, PATH_B), at(1));
    expect(findPosition(keys(1, ID, PATH_A), 100)).toMatchObject({ page: 40, via: 'hash' });
    expect(findPosition(keys(2, ID, PATH_B), 100)).toBeNull();
  });

  it('page 1 at the default fit leaves an entry that shares only the path alone', () => {
    setReadingPosition(keys(1, ID, PATH), at(40));
    setReadingPosition(keys(2, OTHER_ID, PATH), at(1));
    expect(findPosition(keys(1, ID, PATH), 100)).toMatchObject({ page: 40, via: 'hash' });
    expect(findPosition(keys(2, OTHER_ID, PATH), 100)).toBeNull();
  });

  it('deletes the entry outright when no other shares an alias', () => {
    setReadingPosition(keys(1, ID, PATH), at(40));
    setReadingPosition(keys(1, ID, PATH), at(1));
    expect(stored().entries).toEqual({});
  });

  it('resumes again once the reader moves on from a reset', () => {
    setReadingPosition(keys(1, ID, PATH), at(40));
    setReadingPosition(keys(2, ID, PATH), at(1));
    setReadingPosition(keys(2, ID, PATH), at(12));
    expect(findPosition(keys(2, ID, PATH), 100)).toMatchObject({ page: 12, via: 'hash' });
  });
});

describe('aliases', () => {
  it('normalises slashes and the case of Windows drive paths only', () => {
    expect(normalisePath('C:\\Docs\\A.pdf')).toBe('c:/docs/a.pdf');
    expect(normalisePath('c:/DOCS/a.pdf')).toBe('c:/docs/a.pdf');
    expect(normalisePath('/Home/A.pdf')).toBe('/Home/A.pdf');
  });

  it('hashes with a prefix, so an id and a path of the same text differ', async () => {
    const a = await idAlias('same');
    const b = await pathAlias('same');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(await pathAlias('C:\\Docs\\A.pdf')).toBe(await pathAlias('c:/docs/a.pdf'));
  });
});
