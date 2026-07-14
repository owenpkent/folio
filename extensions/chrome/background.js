// Folio Chrome extension — background service worker.
//
// Two ways to open a PDF in Folio:
//   A) Hand off to the Folio DESKTOP app via the folio:// deep link
//      (right-click a PDF link / the PDF page, or click the toolbar icon).
//   B) Render it in Folio's IN-BROWSER viewer (the bundled web build),
//      by redirecting PDF navigations to dist/index.html#file=<url>.
//
// The bundled viewer lives in dist/ and is produced by build.mjs.

const REDIRECT_RULE_ID = 1;

// --- Option A: hand off to the desktop app ---------------------------------
function openInDesktop(pdfUrl) {
  if (!pdfUrl) return;
  // Navigating to a custom scheme invokes the OS protocol handler (folio://),
  // which the desktop app registers at install time.
  chrome.tabs.create({ url: `folio://open?url=${encodeURIComponent(pdfUrl)}` });
}

// --- Option B: redirect PDFs to the in-browser viewer ----------------------
// Set as a dynamic rule so we can build the absolute chrome-extension:// URL
// from this extension's id at runtime. The matched PDF URL (\0) is carried in
// the fragment (#file=) so it survives without colliding with query parsing.
async function installRedirectRule() {
  const viewer = chrome.runtime.getURL('dist/index.html');
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [REDIRECT_RULE_ID],
    addRules: [
      {
        id: REDIRECT_RULE_ID,
        priority: 1,
        action: { type: 'redirect', redirect: { regexSubstitution: `${viewer}#file=\\0` } },
        condition: {
          regexFilter: '^https?://.*\\.pdf(\\?.*)?$',
          resourceTypes: ['main_frame'],
        },
      },
    ],
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
    documentUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*'],
  });
  void installRedirectRule();
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'folio-open-desktop-link') openInDesktop(info.linkUrl);
  else if (info.menuItemId === 'folio-open-desktop-page') openInDesktop(info.pageUrl);
});

// Toolbar click: open the current tab's PDF in the desktop app.
chrome.action.onClicked.addListener((tab) => {
  if (tab.url) openInDesktop(tab.url);
});
