import { describe, expect, it } from 'vitest';

import type { PageLink } from '@/core/pdf/types';

import {
  pickLink,
  pickTextItem,
  targetFromLink,
  targetFromText,
  type TextItemLike,
} from './resolve';

/**
 * A text item on a baseline at `y`, starting at `x`, 10 units tall. Widths are
 * roughly 5 units per character, which is all the geometry these tests need.
 */
const item = (str: string, x: number, y: number, width = str.length * 5): TextItemLike => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  width,
  height: 10,
});

const link = (url: string, rect: [number, number, number, number]): PageLink => ({ url, rect });

describe('pickLink', () => {
  const links = [
    link('https://example.com', [10, 100, 200, 120]),
    link('https://inner.example.com', [50, 105, 90, 115]),
  ];

  it('finds the link under the point', () => {
    expect(pickLink(links, 20, 110)?.url).toBe('https://example.com');
  });

  it('prefers the smaller rect where two overlap', () => {
    expect(pickLink(links, 70, 110)?.url).toBe('https://inner.example.com');
  });

  it('finds nothing away from every link', () => {
    expect(pickLink(links, 400, 400)).toBeNull();
  });

  it('allows a little slack around the edge', () => {
    expect(pickLink(links, 9, 110)?.url).toBe('https://example.com');
    expect(pickLink(links, 4, 110)).toBeNull();
  });

  it('copes with a rect whose corners are the other way round', () => {
    const flipped = [link('https://flipped.example', [200, 120, 10, 100])];
    expect(pickLink(flipped, 20, 110)?.url).toBe('https://flipped.example');
  });
});

describe('targetFromLink', () => {
  it('reads a web target as a url', () => {
    expect(targetFromLink(link('https://example.com', [0, 0, 1, 1]))).toEqual({
      kind: 'url',
      value: 'https://example.com',
      source: 'annotation',
    });
  });

  it('reads a mailto target as an email, without the scheme', () => {
    expect(targetFromLink(link('mailto:owen@example.com', [0, 0, 1, 1]))).toEqual({
      kind: 'email',
      value: 'owen@example.com',
      source: 'annotation',
    });
  });
});

describe('pickTextItem', () => {
  const items = [item('hello', 10, 100), item('world', 60, 100), item('below', 10, 60)];

  it('finds the item under the point', () => {
    expect(pickTextItem(items, 20, 104)).toBe(0);
    expect(pickTextItem(items, 70, 104)).toBe(1);
  });

  it('finds nothing in empty space', () => {
    expect(pickTextItem(items, 300, 300)).toBe(-1);
  });

  it('skips an item with no text', () => {
    expect(pickTextItem([item('', 10, 100)], 20, 104)).toBe(-1);
  });
});

describe('targetFromText', () => {
  it('finds an address inside a single item', () => {
    const items = [item('Write to owen@example.com today', 10, 100)];
    expect(targetFromText(items, 60, 104)).toEqual({
      kind: 'email',
      value: 'owen@example.com',
      source: 'text',
    });
  });

  it('finds nothing where the text holds no address', () => {
    expect(targetFromText([item('just some words', 10, 100)], 20, 104)).toBeNull();
  });

  it('finds nothing away from the text', () => {
    expect(targetFromText([item('owen@example.com', 10, 100)], 400, 400)).toBeNull();
  });

  it('picks the address nearest the point when an item holds two', () => {
    const text = 'a@one.com and b@two.com';
    const items = [item(text, 0, 100)];
    const [x0, x1] = [0, text.length * 5];

    expect(targetFromText(items, x0 + 5, 104)?.value).toBe('a@one.com');
    expect(targetFromText(items, x1 - 5, 104)?.value).toBe('b@two.com');
  });

  it('joins an address PDF.js split across touching items', () => {
    // 5 units per character, so "owen@" ends exactly where "example.com" starts.
    const items = [item('owen@', 10, 100), item('example.com', 35, 100)];
    expect(targetFromText(items, 40, 104)).toEqual({
      kind: 'email',
      value: 'owen@example.com',
      source: 'text',
    });
  });

  it('does not join across a word gap, which would invent an address', () => {
    // "visit" then a space then "example.com" would read as "visitexample.com".
    const items = [item('visit', 10, 100), item('example.com', 60, 100)];
    expect(targetFromText(items, 20, 104)).toBeNull();
  });

  it('does not join across a line break', () => {
    const items = [item('owen@', 10, 100), item('example.com', 35, 60)];
    expect(targetFromText(items, 20, 104)).toBeNull();
  });

  it('still finds the address when the point is on the second half of a split', () => {
    const items = [item('owen@', 10, 100), item('example.com', 35, 100)];
    expect(targetFromText(items, 80, 104)?.value).toBe('owen@example.com');
  });
});
