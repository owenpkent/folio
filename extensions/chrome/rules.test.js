import { describe, expect, it } from 'vitest';

import {
  PDF_MENU_PATTERNS,
  RULE_IDS,
  buildRules,
  handoffUrlForTab,
  isHandoffableUrl,
  isPdfUrl,
  originalUrlFromViewer,
} from './rules.js';
import { MODES } from './settings.js';

const VIEWER = 'chrome-extension://abcdefghijklmnop/dist/index.html';

describe('isPdfUrl', () => {
  it('matches a plain .pdf URL, with or without a query', () => {
    expect(isPdfUrl('https://example.com/a.pdf')).toBe(true);
    expect(isPdfUrl('https://example.com/a.pdf?v=2')).toBe(true);
    expect(isPdfUrl('http://example.com/deep/path/a.PDF')).toBe(true);
  });

  it('does not match a .pdf that only appears in the query string', () => {
    // Rule 1 must not claim this: the path is a page, not a document.
    expect(isPdfUrl('https://example.com/view?doc=a.pdf')).toBe(false);
  });

  it('matches a .pdf URL carrying a fragment', () => {
    // tabs.Tab.url keeps the fragment; the standard Adobe deep-link form
    // (report.pdf#page=3) must still be recognised as a PDF, or the toolbar
    // button stays disabled and the page context-menu entry never appears.
    expect(isPdfUrl('https://example.com/report.pdf#page=3')).toBe(true);
    expect(isPdfUrl('https://example.com/a.pdf?v=2#page=3')).toBe(true);
  });

  it('does not match non-http schemes or the viewer itself', () => {
    expect(isPdfUrl('file:///c:/tmp/a.pdf')).toBe(false);
    expect(isPdfUrl(`${VIEWER}#file=https://example.com/a.pdf`)).toBe(false);
  });

  it('tolerates a missing url', () => {
    expect(isPdfUrl(undefined)).toBe(false);
    expect(isPdfUrl(null)).toBe(false);
  });
});

describe('buildRules', () => {
  const rules = buildRules(VIEWER);

  it('gives the URL rule the higher priority', () => {
    const byUrl = rules.find((r) => r.id === RULE_IDS.PDF_URL);
    const byType = rules.find((r) => r.id === RULE_IDS.PDF_CONTENT_TYPE);
    // The whole point: .pdf URLs get caught before the request is sent, so the
    // content-type rule (which costs a double fetch) never sees them.
    expect(byUrl.priority).toBeGreaterThan(byType.priority);
  });

  it('only ever redirects top-level navigations', () => {
    // Anything wider would catch the viewer's own fetch of the PDF.
    for (const rule of rules) {
      expect(rule.condition.resourceTypes).toEqual(['main_frame']);
    }
  });

  it('carries the matched URL into the viewer fragment', () => {
    for (const rule of rules) {
      expect(rule.action.redirect.regexSubstitution).toBe(`${VIEWER}#file=\\0`);
    }
  });

  it('leaves explicit downloads alone', () => {
    const byType = rules.find((r) => r.id === RULE_IDS.PDF_CONTENT_TYPE);
    expect(byType.condition.excludedResponseHeaders).toEqual([
      { header: 'content-disposition', values: ['attachment*'] },
    ]);
  });

  it('accepts a content-type with parameters', () => {
    const byType = rules.find((r) => r.id === RULE_IDS.PDF_CONTENT_TYPE);
    const [{ values }] = byType.condition.responseHeaders;
    // `application/pdf; charset=utf-8` is common and must still match.
    expect(values.some((v) => v === 'application/pdf*')).toBe(true);
  });

  it('never matches the viewer origin, so a redirect loop is unreachable', () => {
    for (const rule of rules) {
      expect(new RegExp(rule.condition.regexFilter, 'i').test(VIEWER)).toBe(false);
    }
  });

  it('only redirects a GET, so a POST-returned PDF is not re-requested', () => {
    // The viewer's fetch of the redirect target has no method and no body:
    // a PDF a POST generated (a report, a search result) would 404/405
    // instead of rendering if this were not restricted to GET.
    for (const rule of rules) {
      expect(rule.condition.requestMethods).toEqual(['get']);
    }
  });
});

describe('buildRules honours settings', () => {
  it('installs nothing unless the user chose the in-browser viewer', () => {
    // Turning it off must remove the rules, not leave them installed and
    // second-guess them at redirect time.
    expect(buildRules(VIEWER, { mode: MODES.OFF })).toEqual([]);
    expect(buildRules(VIEWER, { mode: MODES.DESKTOP })).toEqual([]);
    expect(buildRules(VIEWER, { mode: MODES.BROWSER })).toHaveLength(2);
  });

  it('excludes the sites the user listed, on both rules', () => {
    const rules = buildRules(VIEWER, { mode: MODES.BROWSER, excludedSites: ['example.com'] });
    for (const rule of rules) {
      expect(rule.condition.excludedRequestDomains).toEqual(['example.com']);
    }
  });

  it('omits the exclusion key entirely when nothing is excluded', () => {
    for (const rule of buildRules(VIEWER)) {
      expect(rule.condition).not.toHaveProperty('excludedRequestDomains');
    }
  });

  it('normalizes exclusions coming from storage', () => {
    const rules = buildRules(VIEWER, { mode: MODES.BROWSER, excludedSites: ['HTTPS://Example.com/x'] });
    expect(rules[0].condition.excludedRequestDomains).toEqual(['example.com']);
  });
});

describe('originalUrlFromViewer', () => {
  it('recovers the document URL from a viewer tab', () => {
    const original = 'https://example.com/download?doc=42&fmt=pdf';
    expect(originalUrlFromViewer(`${VIEWER}#file=${original}`, VIEWER)).toBe(original);
  });

  it('keeps ampersands intact', () => {
    // The regression that motivated reading the fragment verbatim: a query
    // string parser would truncate this at the first &.
    const original = 'https://example.com/a?x=1&y=2';
    expect(originalUrlFromViewer(`${VIEWER}#file=${original}`, VIEWER)).toContain('&y=2');
  });

  it('returns null for a tab that is not the viewer', () => {
    expect(originalUrlFromViewer('https://example.com/a.pdf', VIEWER)).toBeNull();
    expect(originalUrlFromViewer(VIEWER, VIEWER)).toBeNull();
    expect(originalUrlFromViewer(undefined, VIEWER)).toBeNull();
  });
});

describe('isHandoffableUrl', () => {
  it('accepts only http and https', () => {
    expect(isHandoffableUrl('https://example.com/a.pdf')).toBe(true);
    expect(isHandoffableUrl('http://example.com/a.pdf')).toBe(true);
    expect(isHandoffableUrl('javascript:alert(1)')).toBe(false);
    expect(isHandoffableUrl('data:application/pdf;base64,AA==')).toBe(false);
    expect(isHandoffableUrl('file:///c:/a.pdf')).toBe(false);
    expect(isHandoffableUrl('folio://open?url=x')).toBe(false);
    expect(isHandoffableUrl('not a url')).toBe(false);
    expect(isHandoffableUrl(undefined)).toBe(false);
  });
});

describe('PDF_MENU_PATTERNS', () => {
  // Chrome's match patterns compare the path byte-for-byte with no
  // case-insensitive option, unlike isPdfUrl (the `i` flag) and both DNR
  // rules (isUrlFilterCaseSensitive: false), so the only way a context menu
  // catches "Report.PDF" is to list every casing of the extension.
  const matches = (pattern, url) => {
    // Match patterns use '*' as a wildcard over any characters; translate the
    // literal parts and reuse RegExp rather than pull in a matcher.
    const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(url);
  };

  it('covers every casing of the .pdf extension', () => {
    for (const ext of ['pdf', 'PDF', 'Pdf', 'pDf']) {
      const url = `https://example.com/report.${ext}`;
      expect(PDF_MENU_PATTERNS.some((p) => matches(p, url))).toBe(true);
    }
  });

  it('covers the extension with a trailing query string', () => {
    expect(PDF_MENU_PATTERNS.some((p) => matches(p, 'https://example.com/report.PDF?v=2'))).toBe(true);
  });

  it('is exactly the case permutations of *://*/*.pdf and its ?* form', () => {
    expect(PDF_MENU_PATTERNS).toHaveLength(16);
    expect(PDF_MENU_PATTERNS).toContain('*://*/*.pdf');
    expect(PDF_MENU_PATTERNS).toContain('*://*/*.PDF');
    expect(PDF_MENU_PATTERNS).toContain('*://*/*.pdf?*');
    expect(PDF_MENU_PATTERNS).toContain('*://*/*.PDF?*');
  });
});

describe('handoffUrlForTab', () => {
  it('refuses a hostile scheme parked in the viewer fragment', () => {
    // A page can navigate the user to the viewer with any fragment it likes and
    // wait for them to press the toolbar button. That must not become a
    // folio:// link wrapped around javascript:.
    expect(handoffUrlForTab(`${VIEWER}#file=javascript:alert(1)`, VIEWER)).toBeNull();
    expect(handoffUrlForTab(`${VIEWER}#file=file:///c:/secret.pdf`, VIEWER)).toBeNull();
  });

  it('prefers the original document when we are already showing it', () => {
    const original = 'https://example.com/a.pdf';
    expect(handoffUrlForTab(`${VIEWER}#file=${original}`, VIEWER)).toBe(original);
  });

  it('falls back to the tab URL when the PDF was not intercepted', () => {
    expect(handoffUrlForTab('https://example.com/a.pdf', VIEWER)).toBe('https://example.com/a.pdf');
  });

  it('recognises a .pdf tab URL carrying a fragment', () => {
    // chrome.tabs.Tab.url keeps the fragment; the standard Adobe deep-link
    // form must still enable the toolbar button.
    expect(handoffUrlForTab('https://example.com/report.pdf#page=3', VIEWER)).toBe(
      'https://example.com/report.pdf#page=3',
    );
  });

  it('returns null on an ordinary page, so the toolbar does nothing', () => {
    expect(handoffUrlForTab('https://example.com/', VIEWER)).toBeNull();
  });
});
