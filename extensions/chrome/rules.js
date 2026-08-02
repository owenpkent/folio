// declarativeNetRequest rules that send PDF navigations to Folio's viewer.
//
// Two rules, deliberately. They are not interchangeable, and the difference is
// measurable (see the Phase 1 spike):
//
//   Rule 1 matches the URL, so it fires BEFORE the request is sent. The origin
//   serves nothing at all. This is the cheap path and it must win.
//
//   Rule 2 matches the response's content-type, so it can only fire once the
//   response has arrived. The origin serves the whole PDF, Chrome discards it,
//   and the viewer then fetches it again. That double fetch is the price of
//   catching PDFs whose URL gives no hint (`/download?id=123`), which is most
//   PDFs served from behind an application.
//
// Rule 1 therefore carries the higher priority: anything ending in .pdf is
// caught at the URL stage and never reaches the response stage.
//
// These are dynamic rules rather than a static ruleset. A static rule cannot
// interpolate the matched URL into an extension URL: `extensionPath` takes a
// fixed path, and `regexSubstitution` needs the absolute chrome-extension://
// origin, whose id is not known until the extension is installed. Pinning the
// id with a manifest `key` would allow it, but the Chrome Web Store assigns its
// own id, so that pin would not survive publication. Dynamic rules persist
// across browser restarts, so the cost is only that they must be asserted once
// at install and re-asserted at startup.

import { DEFAULTS, normalizeSettings, shouldIntercept } from './settings.js';

/** Rule ids we own. Anything not in here is not ours and is left alone. */
export const RULE_IDS = Object.freeze({ PDF_URL: 1, PDF_CONTENT_TYPE: 2 });

/**
 * URLs whose path ends in `.pdf`, with an optional query string.
 * `[^?#]*` keeps the `.pdf` test on the path, so `/page?doc=x.pdf` is not a hit.
 */
export const PDF_URL_REGEX = '^https?://[^?#]*\\.pdf(\\?[^#]*)?$';

/** Any http(s) navigation. Rule 2 leans on its response-header condition to narrow. */
const ANY_HTTP_REGEX = '^https?://.*';

/** Content types we treat as a PDF. Trailing `*` absorbs `; charset=...`. */
const PDF_CONTENT_TYPES = ['application/pdf*', 'application/x-pdf*'];

/**
 * Build the redirect target. The matched URL is substituted verbatim by `\0`
 * and carried in the fragment, un-encoded, so it survives without colliding
 * with the viewer's own query parsing. `openFromQueryParam` reads everything
 * after `#file=` literally for exactly this reason: the original URL may
 * itself contain `&` and `=`.
 */
function redirectTo(viewerUrl) {
  return { regexSubstitution: `${viewerUrl}#file=\\0` };
}

/**
 * The two redirect rules, given the absolute URL of the bundled viewer
 * (`chrome.runtime.getURL('dist/index.html')`).
 *
 * Both are scoped to `main_frame`, which is what keeps the viewer from
 * redirecting its own `fetch()` of the PDF into itself. The viewer lives on
 * chrome-extension:// and neither regex matches that scheme, so a navigation
 * loop is not reachable either.
 */
export function buildRules(viewerUrl, settings = DEFAULTS) {
  const { excludedSites } = normalizeSettings(settings);

  // Off, or desktop-hand-off-only: install nothing. An empty rule set is how
  // the user turns interception off, rather than leaving rules in place and
  // second-guessing them at redirect time.
  if (!shouldIntercept(settings)) return [];

  // `excludedRequestDomains` covers subdomains, which is what a user typing
  // "example.com" into the exclusion list means. Omitted entirely when empty:
  // an empty array is a valid-but-pointless condition and reads as a mistake.
  const excluded = excludedSites.length ? { excludedRequestDomains: excludedSites } : {};

  return [
    {
      id: RULE_IDS.PDF_URL,
      priority: 2,
      action: { type: 'redirect', redirect: redirectTo(viewerUrl) },
      condition: {
        regexFilter: PDF_URL_REGEX,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame'],
        ...excluded,
      },
    },
    {
      id: RULE_IDS.PDF_CONTENT_TYPE,
      priority: 1,
      action: { type: 'redirect', redirect: redirectTo(viewerUrl) },
      condition: {
        regexFilter: ANY_HTTP_REGEX,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame'],
        ...excluded,
        responseHeaders: [{ header: 'content-type', values: PDF_CONTENT_TYPES }],
        // A server that asked for a download gets its download.
        //
        // Known limitation, measured rather than assumed: this only protects
        // downloads that rule 2 handles. A URL ending in `.pdf` is caught by
        // rule 1 at the URL stage, where no response headers exist yet, so
        // `content-disposition: attachment` on a `.pdf` URL is still opened in
        // the viewer. Verified: such a request never reaches the origin at all.
        //
        // Fixing that would mean giving rule 1 a response-header condition too,
        // which moves it to the response stage and forfeits the zero-fetch win
        // on the common path -- a constant tax on every PDF to correct an
        // uncommon case. The viewer offers a download instead. Revisit if the
        // options page grows a "respect download links" toggle.
        excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
      },
    },
  ];
}

/** Does this URL look like a PDF from its path alone? Mirrors rule 1. */
export function isPdfUrl(url) {
  return new RegExp(PDF_URL_REGEX, 'i').test(url ?? '');
}

/**
 * Recover the PDF's original URL from a viewer tab's URL, or null if the tab is
 * not the viewer. Lets the toolbar hand the real document to the desktop app
 * rather than a chrome-extension:// address it cannot open.
 */
export function originalUrlFromViewer(tabUrl, viewerUrl) {
  if (!tabUrl || !viewerUrl || !tabUrl.startsWith(viewerUrl)) return null;
  const marker = '#file=';
  const at = tabUrl.indexOf(marker);
  if (at === -1) return null;
  return tabUrl.slice(at + marker.length) || null;
}

/**
 * Is this something we are willing to hand to the desktop app?
 *
 * The viewer's fragment is chosen by whatever navigated to it, so a URL
 * recovered from it is untrusted: a page can park the user on the viewer with
 * `#file=javascript:…` and wait for them to click the toolbar button. The
 * desktop side re-validates (`fetch_pdf` rejects non-http(s) and resolves the
 * host against a private-range blocklist), so this is the outer of two checks
 * rather than the only one, but the extension should not be building a
 * `folio://` link around an arbitrary scheme in the first place.
 */
export function isHandoffableUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * The URL the toolbar action should hand to the desktop app for a given tab:
 * the original document if we are already showing it, the tab's own URL if it
 * is a PDF, otherwise null (nothing sensible to do).
 */
export function handoffUrlForTab(tabUrl, viewerUrl) {
  const candidate = originalUrlFromViewer(tabUrl, viewerUrl) ?? (isPdfUrl(tabUrl) ? tabUrl : null);
  return candidate && isHandoffableUrl(candidate) ? candidate : null;
}
