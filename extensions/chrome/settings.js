// User settings for the extension, and the pure logic around them.
//
// Kept free of `chrome.*` so it can be unit tested directly; the storage calls
// live in storage.js and background.js.

/** What the extension does when it meets a PDF. */
export const MODES = Object.freeze({
  /** Render it in Folio's bundled viewer. The default. */
  BROWSER: 'browser',
  /** Leave the browser alone; only offer the desktop hand-off on demand. */
  DESKTOP: 'desktop',
  /** Do nothing at all. Chrome's own viewer handles PDFs as usual. */
  OFF: 'off',
});

export const DEFAULTS = Object.freeze({
  mode: MODES.BROWSER,
  /** Hostnames where interception is skipped. Subdomains are covered. */
  excludedSites: [],
});

/**
 * Reduce user input to a bare hostname, or null if there isn't one.
 * Accepts what people actually type: `example.com`, `www.example.com/docs`,
 * `https://example.com`, and tolerates surrounding whitespace.
 *
 * A leading `*.` (or bare `*`) is stripped rather than rejected: it is how
 * people spell "cover subdomains", which `excludedRequestDomains` already
 * does for the bare host (see `buildRules` in rules.js), so `*.example.com`
 * and `example.com` mean the same thing here. Passed through unchanged,
 * `new URL('https://*.example.com')` parses fine and returns the literal
 * asterisk in `hostname` -- declarativeNetRequest then rejects the
 * non-canonical domain at `updateDynamicRules` time, which is a rejection
 * this module's caller has no reason to expect from typing the obvious thing
 * into a "sites to leave alone" box. Any other `*` (there is no wildcard
 * syntax `excludedRequestDomains` accepts) is refused outright, the same as
 * any other unparseable host.
 */
export function normalizeHost(input) {
  const trimmed = String(input ?? '').trim().replace(/^\*\.?/, '');
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const { hostname } = new URL(withScheme);
    return hostname && !hostname.includes('*') ? hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Comfortably under chrome.storage.sync's 8 KB per-item quota even at the
 * longest realistic hostnames, with headroom for JSON's per-entry overhead. */
const MAX_EXCLUDED_SITES = 200;

/** One host per line, blanks and unparseable lines dropped, de-duplicated,
 * capped at MAX_EXCLUDED_SITES so a large paste cannot by itself exceed the
 * storage quota `saveSettings` writes into (see storage.js). */
export function parseSiteList(text) {
  const seen = new Set();
  for (const line of String(text ?? '').split(/[\r\n,]+/)) {
    if (seen.size >= MAX_EXCLUDED_SITES) break;
    const host = normalizeHost(line);
    if (host) seen.add(host);
  }
  return [...seen];
}

/** Render a stored list back into the textarea's one-per-line form. */
export function formatSiteList(sites) {
  return (Array.isArray(sites) ? sites : []).join('\n');
}

/**
 * Coerce whatever came out of storage into a valid settings object. Storage is
 * schemaless and survives extension downgrades, so an unknown mode or a
 * non-array site list must not be able to wedge the extension.
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const mode = Object.values(MODES).includes(source.mode) ? source.mode : DEFAULTS.mode;
  const excludedSites = Array.isArray(source.excludedSites)
    ? parseSiteList(source.excludedSites.join('\n'))
    : [...DEFAULTS.excludedSites];
  return { mode, excludedSites };
}

/** Should the extension redirect PDF navigations at all? */
export function shouldIntercept(settings) {
  return normalizeSettings(settings).mode === MODES.BROWSER;
}
