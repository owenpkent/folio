// Folio Chrome extension -- background service worker.
//
// Two ways to open a PDF in Folio:
//   A) Hand off to the Folio DESKTOP app via the folio:// deep link
//      (right-click a PDF link / the PDF page, or click the toolbar icon).
//   B) Render it in Folio's IN-BROWSER viewer (the bundled web build), by
//      redirecting PDF navigations to dist/index.html#file=<url>.
//
// Which of those happens is the user's choice; see settings.js and options.html.
// The redirect rules live in rules.js -- see the comment there for why there are
// two of them and why they are dynamic rather than static.
//
// The bundled viewer lives in dist/ and is produced by build.mjs.

import { RULE_IDS, buildRules, handoffUrlForTab, isHandoffableUrl } from './rules.js';
import { MODES } from './settings.js';
import { loadSettings, onSettingsChanged } from './storage.js';

const MENU_LINK = 'folio-open-desktop-link';
const MENU_PAGE = 'folio-open-desktop-page';

const viewerUrl = () => chrome.runtime.getURL('dist/index.html');

// --- Option A: hand off to the desktop app ---------------------------------
function openInDesktop(pdfUrl) {
  // The single choke point for handing a URL to the desktop app, so every path
  // into it (toolbar, both context menus) is scheme-checked once rather than
  // each remembering to. A URL recovered from the viewer's fragment was chosen
  // by whatever navigated there.
  if (!pdfUrl || !isHandoffableUrl(pdfUrl)) return;
  // Navigating to a custom scheme invokes the OS protocol handler (folio://),
  // which the desktop app registers at install time.
  chrome.tabs.create({ url: `folio://open?url=${encodeURIComponent(pdfUrl)}` });
}

// --- Option B: redirect PDFs to the in-browser viewer ----------------------
// Dynamic rules survive browser restarts, so this is not needed on every worker
// wake-up. It is asserted at install, at startup, and whenever settings change.
// `buildRules` returns an empty list unless the user chose the in-browser mode,
// so turning the extension off genuinely removes the rules rather than leaving
// them installed and second-guessing them later.
async function applyRules(settings) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: Object.values(RULE_IDS),
    addRules: buildRules(viewerUrl(), settings),
  });
}

// --- Context menus ----------------------------------------------------------
async function applyMenus(settings) {
  await chrome.contextMenus.removeAll();
  if (settings.mode === MODES.OFF) return;

  chrome.contextMenus.create({
    id: MENU_LINK,
    title: 'Open link in Folio (desktop)',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*'],
  });
  chrome.contextMenus.create({
    id: MENU_PAGE,
    title: 'Open this PDF in Folio (desktop)',
    contexts: ['page'],
    // PDFs we did not intercept, plus the viewer itself once we did. Without
    // the second pattern the entry vanishes on exactly the pages where the
    // extension is working.
    documentUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', `${viewerUrl()}*`],
  });
}

// --- Toolbar button ---------------------------------------------------------
// The button only does something on a PDF, so it is only enabled on a PDF.
// A button that is always clickable but usually inert is worse than one that
// tells you, before you click, that there is nothing to click.
async function applyActionState(tab, settings) {
  if (!tab?.id) return;
  const target = settings.mode === MODES.OFF ? null : handoffUrlForTab(tab.url, viewerUrl());
  if (target) {
    await chrome.action.enable(tab.id);
    await chrome.action.setTitle({ tabId: tab.id, title: 'Open this PDF in Folio (desktop)' });
  } else {
    await chrome.action.disable(tab.id);
    await chrome.action.setTitle({ tabId: tab.id, title: 'Folio: no PDF on this page' });
  }
}

async function refreshTab(tabId) {
  try {
    const [tab, settings] = await Promise.all([chrome.tabs.get(tabId), loadSettings()]);
    await applyActionState(tab, settings);
  } catch {
    // The tab went away between the event and this call. Nothing to do.
  }
}

async function applyAll() {
  const settings = await loadSettings();
  await Promise.all([applyRules(settings), applyMenus(settings)]);
  return settings;
}

// --- Wiring -----------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  void applyAll();
});

chrome.runtime.onStartup.addListener(() => {
  void applyAll();
});

onSettingsChanged(() => {
  void applyAll().then(async (settings) => {
    // The open tab's button may have just become (ir)relevant.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await applyActionState(tab, settings);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void refreshTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Only the URL matters here; ignore the loading/title churn.
  if (changeInfo.url) void refreshTab(tabId);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_LINK) {
    openInDesktop(info.linkUrl);
  } else if (info.menuItemId === MENU_PAGE) {
    // On a page we already redirected, info.pageUrl is the chrome-extension://
    // viewer, which the desktop app cannot open. Recover the real document.
    openInDesktop(handoffUrlForTab(info.pageUrl ?? tab?.url, viewerUrl()));
  }
});

chrome.action.onClicked.addListener((tab) => {
  openInDesktop(handoffUrlForTab(tab?.url, viewerUrl()));
});
