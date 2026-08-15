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

  it('accepts a scheme URL whatever the host looks like: a scheme is the whole signal', () => {
    expect(values('Go to https://example.com:8443/path now')).toEqual([
      'https://example.com:8443/path',
    ]);
    expect(values('See http://intranet/docs for detail')).toEqual(['http://intranet/docs']);
    expect(values('Reach it at https://192.168.0.1/report')).toEqual([
      'https://192.168.0.1/report',
    ]);
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

  it('leaves two sentences run together alone, even when the next word spells a suffix', () => {
    // OCR, and a missing space after a full stop generally, routinely produce
    // this: the next sentence's capitalized first word must not be read as a
    // domain suffix just because it happens to spell a common TLD.
    expect(values('Reading the total cost.It was high enough')).toEqual([]);
    expect(values('See the appendix.At the end of the report')).toEqual([]);
    expect(values('As we agree.In future we will not')).toEqual([]);
    expect(values('Ask them.Us employees know better')).toEqual([]);
    expect(values('File the report.No changes are needed')).toEqual([]);
    expect(values('Talk to me.Me and my colleague agree')).toEqual([]);
    expect(values('Let it be.Be that as it may')).toEqual([]);
    expect(values('Check the price.Info about it is elsewhere')).toEqual([]);
  });

  it('leaves the path-only suffixes alone: an abbreviation glued to a lowercase word', () => {
    // it/at/in/us/me/be/no/co/de/ie are in PATH_ONLY_SUFFIXES (see its doc
    // comment) for reading as ordinary English words or abbreviations. The
    // capitalization heuristic in the test above only catches a dropped space
    // at a SENTENCE boundary (a capitalized next word); these glue an
    // abbreviation to a lowercase continuation instead, the same shape as
    // "vs.the" and "etc.and" two tests up, which has no capital letter for
    // that heuristic to catch. What stops all of them is that prose ends the
    // token at the suffix, so none of these carries a path.
    expect(values('the annual report.co branding stayed')).toEqual([]);
    expect(values('translate the manual.us edition first')).toEqual([]);
    expect(values('see Fig.at the bottom of the page')).toEqual([]);
    expect(values('read No.in the appendix for detail')).toEqual([]);
    expect(values('the current Rev.no changes are pending')).toEqual([]);
    expect(values('check the memo.de parting soon')).toEqual([]);
    expect(values('check the memo.ie leaving today')).toEqual([]);
  });

  it('detects a path-only suffix once the token actually carries a path', () => {
    // The two most common bare short links in real documents, plus a country
    // suffix with a path. A path segment is what a run-together sentence never
    // has, so accepting these costs none of the prose cases above.
    expect(values('Watch youtu.be/dQw4w9WgXcQ for the demo')).toEqual(['youtu.be/dQw4w9WgXcQ']);
    expect(values('Shortened to t.co/aB3xY9 for the tweet')).toEqual(['t.co/aB3xY9']);
    expect(values('See spiegel.de/politik for coverage')).toEqual(['spiegel.de/politik']);
    // A query or a fragment counts as the path segment too, not just a slash.
    expect(values('Open youtu.be?v=abc123 now')).toEqual(['youtu.be?v=abc123']);
    expect(values('Jump to spiegel.de#top please')).toEqual(['spiegel.de#top']);
    // Still nothing without one, which is the accepted residual miss.
    expect(values('Coverage at spiegel.de today')).toEqual([]);
  });

  it('keeps detecting io and info, the two suffixes a coincidental word can still collide with', () => {
    // io and info stay in COMMON_SUFFIXES on purpose (see its doc comment):
    // neither reads as an English word, so "chapter.io" and "on.info" are an
    // accepted residual false positive, not something this trim was meant to
    // fix.
    expect(values('read chapter.io the results follow')).toEqual(['chapter.io']);
    expect(values('based on.info the committee decided')).toEqual(['on.info']);
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
