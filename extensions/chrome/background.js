// Folio Chrome extension -- background service worker.
//
// Two ways to open a PDF in Folio:
//   A) Hand off to the Folio DESKTOP app via the folio:// deep link
//      (right-click a PDF link / the PDF page, or click the toolbar icon).
//   B) Render it in Folio's IN-BROWSER viewer (the bundled web build), by
//      redirecting PDF navigations to dist/index.html#file=<url>.
//
// The redirect rules live in rules.js; see the comment there for why there are
// two of them and why they are dynamic rather than static.
//
// The bundled viewer lives in dist/ and is produced by build.mjs.

import { RULE_IDS, buildRules, handoffUrlForTab } from './rules.js';

const viewerUrl = () => chrome.runtime.getURL('dist/index.html');

// --- Option A: hand off to the desktop app ---------------------------------
function openInDesktop(pdfUrl) {
  if (!pdfUrl) return;
  // Navigating to a custom scheme invokes the OS protocol handler (folio://),
  // which the desktop app registers at install time.
  chrome.tabs.create({ url: `folio://open?url=${encodeURIComponent(pdfUrl)}` });
}

// --- Option B: redirect PDFs to the in-browser viewer ----------------------
// Dynamic rules survive browser restarts, so this is not needed on every worker
// wake-up. It is asserted at install (ids may be new) and at startup (cheap
// insurance against a profile whose rules were dropped or half-written).
async function installRedirectRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: Object.values(RULE_IDS),
    addRules: buildRules(viewerUrl()),
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'folio-open-desktop-link',
    title: 'Open link in Folio (desktop)',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*'],
  });
  chrome.contextMenus.create({
    id: 'folio-open-desktop-page',
    title: 'Open this PDF in Folio (desktop)',
    contexts: ['page'],
    // PDFs we did not intercept, plus the viewer itself once we did. Without
    // the second pattern the entry vanishes on exactly the pages where the
    // extension is working.
    documentUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', `${chrome.runtime.getURL('dist/index.html')}*`],
  });
  void installRedirectRules();
});

chrome.runtime.onStartup.addListener(() => {
  void installRedirectRules();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'folio-open-desktop-link') {
    openInDesktop(info.linkUrl);
  } else if (info.menuItemId === 'folio-open-desktop-page') {
    // On a page we already redirected, info.pageUrl is the chrome-extension://
    // viewer, which the desktop app cannot open. Recover the real document.
    openInDesktop(handoffUrlForTab(info.pageUrl ?? tab?.url, viewerUrl()));
  }
});

// Toolbar click: open the current tab's PDF in the desktop app. Does nothing on
// a tab that is not a PDF, rather than handing the app an arbitrary page URL.
chrome.action.onClicked.addListener((tab) => {
  openInDesktop(handoffUrlForTab(tab?.url, viewerUrl()));
});
