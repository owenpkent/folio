import { describe, expect, it } from 'vitest';

// From the leaf module, not the @/core/pdf barrel: see resolve.ts for why.
import { pickTextItem, type TextItemLike } from '@/core/pdf/textHit';
import type { PageLink } from '@/core/pdf/types';

import { pickLink, targetFromLink, targetFromOcr, targetFromText } from './resolve';

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

  it('strips RFC 6068 headers off a mailto target', () => {
    const url = 'mailto:owen@example.com?subject=Hello%20there&body=hi';
    expect(targetFromLink(link(url, [0, 0, 1, 1]))).toEqual({
      kind: 'email',
      value: 'owen@example.com',
      source: 'annotation',
    });
  });

  it('takes only the first recipient of a mailto naming several', () => {
    expect(targetFromLink(link('mailto:a@x.com,b@y.com', [0, 0, 1, 1]))?.value).toBe('a@x.com');
  });

  it('decodes a percent-encoded mailto address', () => {
    expect(targetFromLink(link('mailto:owen%40example.com', [0, 0, 1, 1]))).toEqual({
      kind: 'email',
      value: 'owen@example.com',
      source: 'annotation',
    });
  });

  it('falls back to the raw target when a mailto has no address to offer', () => {
    expect(targetFromLink(link('mailto:', [0, 0, 1, 1]))).toEqual({
      kind: 'url',
      value: 'mailto:',
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
    expect(targetFromText(items, 60, 104)?.target).toEqual({
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

    expect(targetFromText(items, x0 + 5, 104)?.target.value).toBe('a@one.com');
    expect(targetFromText(items, x1 - 5, 104)?.target.value).toBe('b@two.com');
  });

  it('finds nothing in the gap between two addresses on the same item', () => {
    // The midpoint sits in " and ", clear of both addresses either side of it:
    // it must resolve to neither, not fall back to the leftmost.
    const text = 'a@one.com and b@two.com';
    const items = [item(text, 0, 100)];

    expect(targetFromText(items, (text.length * 5) / 2, 104)).toBeNull();
  });

  it('finds nothing elsewhere on a line that holds exactly one address', () => {
    // A whole line is commonly one PDF.js text item, so without a real point-
    // to-offset check, a paragraph containing exactly one address anywhere in
    // it would offer to copy that address from wherever the pointer landed.
    const items = [item('For questions please contact owen@example.com', 10, 100)];

    expect(targetFromText(items, 15, 104)).toBeNull();
  });

  it('joins an address PDF.js split across touching items', () => {
    // 5 units per character, so "owen@" ends exactly where "example.com" starts.
    const items = [item('owen@', 10, 100), item('example.com', 35, 100)];
    expect(targetFromText(items, 40, 104)?.target).toEqual({
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
    expect(targetFromText(items, 80, 104)?.target.value).toBe('owen@example.com');
  });
});

describe('targetFromText: the box it reports', () => {
  it('covers the address, not the whole line it sits on', () => {
    // "Write to " is 9 characters of a 31-character item starting at x=10 and
    // 155 wide, so the address starts 45 units in and runs to the end.
    const items = [item('Write to owen@example.com', 10, 100)];
    const rect = targetFromText(items, 60, 104)!.rect;

    expect(rect[0]).toBeCloseTo(10 + 9 * 5);
    expect(rect[2]).toBeCloseTo(10 + 25 * 5);
  });

  it('spans every item a split address covers', () => {
    const items = [item('owen@', 10, 100), item('example.com', 35, 100)];
    const rect = targetFromText(items, 40, 104)!.rect;

    expect(rect[0]).toBeCloseTo(10);
    expect(rect[2]).toBeCloseTo(35 + 11 * 5);
  });

  it('stays inside the line vertically', () => {
    const items = [item('owen@example.com', 10, 100)];
    const [, y0, , y1] = targetFromText(items, 40, 104)!.rect;

    expect(y0).toBeCloseTo(98);
    expect(y1).toBeCloseTo(110);
  });
});

describe('targetFromOcr', () => {
  const word = (text: string, x: number, y: number, width = 0.2, height = 0.03) => ({
    text,
    rect: { x, y, width, height },
  });

  it('finds an address in a recognised word', () => {
    const words = [word('owen@example.com', 0.1, 0.2)];
    expect(targetFromOcr(words, 0.15, 0.21)).toEqual({
      target: { kind: 'email', value: 'owen@example.com', source: 'ocr' },
      rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.03 },
    });
  });

  it('finds nothing outside every word', () => {
    expect(targetFromOcr([word('owen@example.com', 0.1, 0.2)], 0.8, 0.8)).toBeNull();
  });

  it('ignores a word that is not an address', () => {
    expect(targetFromOcr([word('invoice', 0.1, 0.2)], 0.15, 0.21)).toBeNull();
  });

  it('strips the punctuation a recogniser leaves attached', () => {
    expect(targetFromOcr([word('(owen@example.com)', 0.1, 0.2)], 0.15, 0.21)?.target.value).toBe(
      'owen@example.com',
    );
  });

  it('prefers the smaller word where two overlap', () => {
    const words = [
      word('a@big.com', 0.1, 0.2, 0.5, 0.1),
      word('b@small.com', 0.2, 0.22, 0.1, 0.02),
    ];
    expect(targetFromOcr(words, 0.25, 0.23)?.target.value).toBe('b@small.com');
  });
});
