import { describe, expect, it } from 'vitest';

import {
  DEFAULTS,
  MODES,
  formatSiteList,
  normalizeHost,
  normalizeSettings,
  parseSiteList,
  shouldIntercept,
} from './settings.js';

describe('normalizeHost', () => {
  it('accepts what people actually type', () => {
    expect(normalizeHost('example.com')).toBe('example.com');
    expect(normalizeHost('  example.com  ')).toBe('example.com');
    expect(normalizeHost('https://example.com')).toBe('example.com');
    expect(normalizeHost('https://example.com/docs/a.pdf')).toBe('example.com');
    expect(normalizeHost('http://Docs.Example.COM')).toBe('docs.example.com');
  });

  it('rejects input with no host in it', () => {
    expect(normalizeHost('')).toBeNull();
    expect(normalizeHost('   ')).toBeNull();
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost(undefined)).toBeNull();
  });
});

describe('parseSiteList', () => {
  it('splits on newlines and commas, dropping blanks', () => {
    expect(parseSiteList('a.com\nb.com,c.com\n\n')).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('de-duplicates after normalizing, not before', () => {
    // These are three spellings of one site and must collapse to one entry.
    expect(parseSiteList('example.com\nhttps://example.com\nEXAMPLE.com/x')).toEqual([
      'example.com',
    ]);
  });

  it('survives junk without throwing', () => {
    expect(parseSiteList(null)).toEqual([]);
    expect(parseSiteList('   \n  ')).toEqual([]);
  });
});

describe('formatSiteList', () => {
  it('round-trips through parseSiteList', () => {
    const sites = ['a.com', 'b.com'];
    expect(parseSiteList(formatSiteList(sites))).toEqual(sites);
  });

  it('tolerates a non-array', () => {
    expect(formatSiteList(undefined)).toBe('');
  });
});

describe('normalizeSettings', () => {
  it('defaults to the in-browser viewer', () => {
    expect(normalizeSettings(undefined)).toEqual({ mode: MODES.BROWSER, excludedSites: [] });
    expect(DEFAULTS.mode).toBe(MODES.BROWSER);
  });

  it('falls back to the default mode when storage holds something unknown', () => {
    // Storage is schemaless and outlives extension versions; an unrecognised
    // mode must not be able to wedge the extension into doing nothing.
    expect(normalizeSettings({ mode: 'wat' }).mode).toBe(MODES.BROWSER);
    expect(normalizeSettings({ mode: null }).mode).toBe(MODES.BROWSER);
    expect(normalizeSettings('not an object').mode).toBe(MODES.BROWSER);
  });

  it('repairs a site list that is not an array', () => {
    expect(normalizeSettings({ excludedSites: 'example.com' }).excludedSites).toEqual([]);
  });

  it('normalizes stored sites, not just freshly typed ones', () => {
    expect(normalizeSettings({ excludedSites: ['HTTPS://Example.com/x'] }).excludedSites).toEqual([
      'example.com',
    ]);
  });
});

describe('shouldIntercept', () => {
  it('is true only in the in-browser mode', () => {
    expect(shouldIntercept({ mode: MODES.BROWSER })).toBe(true);
    expect(shouldIntercept({ mode: MODES.DESKTOP })).toBe(false);
    expect(shouldIntercept({ mode: MODES.OFF })).toBe(false);
  });

  it('defaults to intercepting when settings are missing', () => {
    expect(shouldIntercept(undefined)).toBe(true);
  });
});
