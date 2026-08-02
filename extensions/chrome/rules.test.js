import { describe, expect, it } from 'vitest';

import { RULE_IDS, buildRules, handoffUrlForTab, isPdfUrl, originalUrlFromViewer } from './rules.js';

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

describe('handoffUrlForTab', () => {
  it('prefers the original document when we are already showing it', () => {
    const original = 'https://example.com/a.pdf';
    expect(handoffUrlForTab(`${VIEWER}#file=${original}`, VIEWER)).toBe(original);
  });

  it('falls back to the tab URL when the PDF was not intercepted', () => {
    expect(handoffUrlForTab('https://example.com/a.pdf', VIEWER)).toBe('https://example.com/a.pdf');
  });

  it('returns null on an ordinary page, so the toolbar does nothing', () => {
    expect(handoffUrlForTab('https://example.com/', VIEWER)).toBeNull();
  });
});
