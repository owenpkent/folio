import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearLastDocument, readLastDocument, writeLastDocument } from './lastDocument';

const KEY = 'folio.lastDocument';
const note = { path: '/home/me/a.pdf', name: 'a.pdf', page: 3 };

beforeEach(() => localStorage.clear());

describe('last document note', () => {
  it('round-trips and clears', () => {
    writeLastDocument(note);
    expect(readLastDocument()).toEqual(note);
    clearLastDocument();
    expect(readLastDocument()).toBeNull();
  });

  it.each([
    ['a UNC path', { ...note, path: '//server/share/a.pdf' }],
    ['a relative path', { ...note, path: 'docs/a.pdf' }],
    ['a non-pdf path', { ...note, path: '/home/me/a.txt' }],
    ['an empty name', { ...note, name: '' }],
    ['a non-string name', { ...note, name: 5 }],
    ['page 0', { ...note, page: 0 }],
    ['a fractional page', { ...note, page: 1.5 }],
  ])('refuses %s on write and on read', (_name, bad) => {
    writeLastDocument(bad as never);
    expect(localStorage.getItem(KEY)).toBeNull();
    localStorage.setItem(KEY, JSON.stringify(bad));
    expect(readLastDocument()).toBeNull();
  });

  it('reads garbage as no note and swallows storage errors', () => {
    localStorage.setItem(KEY, '{{');
    expect(readLastDocument()).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writeLastDocument(note)).not.toThrow();
    vi.restoreAllMocks();
  });
});
