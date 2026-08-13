import { describe, expect, it } from 'vitest';

import { addressAt, findAddresses } from './detect';

/** Just the copyable values, which is what the menu item ends up putting on the clipboard. */
const values = (text: string) => findAddresses(text).map((a) => a.value);
const kinds = (text: string) => findAddresses(text).map((a) => a.kind);

describe('findAddresses: email', () => {
  it('finds a plain address', () => {
    expect(values('Write to owen@example.com for help.')).toEqual(['owen@example.com']);
    expect(kinds('owen@example.com')).toEqual(['email']);
  });

  it('drops the trailing sentence punctuation', () => {
    expect(values('Contact owen@example.com.')).toEqual(['owen@example.com']);
    expect(values('owen@example.com, or call.')).toEqual(['owen@example.com']);
  });

  it('unwraps a bracketed address', () => {
    expect(values('Support (owen@example.com) is open.')).toEqual(['owen@example.com']);
    expect(values('Ask "owen@example.com" first.')).toEqual(['owen@example.com']);
  });

  it('strips a mailto: prefix, since that is not part of the address', () => {
    expect(values('mailto:owen@example.com')).toEqual(['owen@example.com']);
    expect(values('MAILTO:owen@example.com')).toEqual(['owen@example.com']);
  });

  it('handles the punctuation real addresses carry', () => {
    expect(values('first.last+tag@sub.example.co.uk')).toEqual([
      'first.last+tag@sub.example.co.uk',
    ]);
  });

  it('ignores something that only looks like one', () => {
    expect(values('see @owenpkent on social')).toEqual([]);
    expect(values('50%@ discount')).toEqual([]);
    expect(values('owen@localhost')).toEqual([]);
  });
});

describe('findAddresses: web addresses', () => {
  it('finds an address with a scheme', () => {
    expect(values('Go to https://example.com/docs now')).toEqual(['https://example.com/docs']);
    expect(kinds('https://example.com')).toEqual(['url']);
  });

  it('finds a www address with no scheme', () => {
    expect(values('Visit www.example.com today')).toEqual(['www.example.com']);
  });

  it('finds a bare domain with a suffix it recognises', () => {
    expect(values('Read more at example.com or ask')).toEqual(['example.com']);
    expect(values('example.co.uk')).toEqual(['example.co.uk']);
  });

  it('leaves an abbreviation alone', () => {
    // The reason bare domains need a known suffix at all.
    expect(values('See Fig.2 and No.4 for detail')).toEqual([]);
    expect(values('the result vs.the baseline')).toEqual([]);
    expect(values('etc.and so on')).toEqual([]);
  });

  it('drops a full stop that ends the sentence, not the address', () => {
    expect(values('Read it at example.com.')).toEqual(['example.com']);
    expect(values('Read https://example.com/a.')).toEqual(['https://example.com/a']);
  });

  it('keeps a bracket the address opened itself', () => {
    expect(values('https://en.wikipedia.org/wiki/Folio_(disambiguation)')).toEqual([
      'https://en.wikipedia.org/wiki/Folio_(disambiguation)',
    ]);
  });

  it('drops a bracket the sentence opened', () => {
    expect(values('(https://example.com/a)')).toEqual(['https://example.com/a']);
  });

  it('keeps a query string and a fragment', () => {
    expect(values('https://example.com/s?q=1&r=2#top')).toEqual([
      'https://example.com/s?q=1&r=2#top',
    ]);
  });

  it('ignores a version number or a file name', () => {
    expect(values('version 1.2.3 shipped')).toEqual([]);
    expect(values('open report.pdf now')).toEqual([]);
    expect(values('the file is data.json')).toEqual([]);
  });
});

describe('findAddresses: several in one run of text', () => {
  it('finds each of them in order', () => {
    const text = 'Email owen@example.com or see https://example.org for more.';
    expect(values(text)).toEqual(['owen@example.com', 'https://example.org']);
    expect(kinds(text)).toEqual(['email', 'url']);
  });

  it('reports where each one sits', () => {
    const text = 'see https://example.com now';
    const [found] = findAddresses(text);
    expect(text.slice(found.start, found.end)).toBe('https://example.com');
  });
});

describe('addressAt', () => {
  const text = 'Email owen@example.com or see https://example.org for more.';

  it('finds the address covering an offset', () => {
    expect(addressAt(text, text.indexOf('owen'))?.value).toBe('owen@example.com');
    expect(addressAt(text, text.indexOf('example.org'))?.value).toBe('https://example.org');
  });

  it('finds one from an offset at its very end', () => {
    const end = text.indexOf('owen@example.com') + 'owen@example.com'.length;
    expect(addressAt(text, end)?.value).toBe('owen@example.com');
  });

  it('finds nothing in the words between them', () => {
    expect(addressAt(text, text.indexOf('or see') + 1)).toBeNull();
  });
});
