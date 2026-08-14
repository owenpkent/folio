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

import { PDF_MENU_PATTERNS, RULE_IDS, buildRules, handoffUrlForTab, isHandoffableUrl } from './rules.js';
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
//
// Applied as two separate updateDynamicRules calls, not one. Rule 2's
// responseHeaders condition needs Chrome 128+; manifest.json declares
// minimum_chrome_version so the Web Store will not install this on anything
// older, but that does not cover every deployment (a sideloaded or
// policy-installed copy). updateDynamicRules is all-or-nothing, so one call
// for both rules would mean a rejection of rule 2 on an old Chrome also wipes
// out rule 1 -- the plain .pdf rule, which needs no new API and would
// otherwise have worked fine. Splitting keeps that failure contained to rule 2.
async function applyRules(settings) {
  const rules = buildRules(viewerUrl(), settings);
  const byId = new Map(rules.map((rule) => [rule.id, rule]));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_IDS.PDF_URL],
    addRules: byId.has(RULE_IDS.PDF_URL) ? [byId.get(RULE_IDS.PDF_URL)] : [],
  });
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_IDS.PDF_CONTENT_TYPE],
    addRules: byId.has(RULE_IDS.PDF_CONTENT_TYPE) ? [byId.get(RULE_IDS.PDF_CONTENT_TYPE)] : [],
  });
}

// --- Context menus ----------------------------------------------------------
// contextMenus.create is documented as the one chrome.* method that does not
// return a promise; without wrapping its callback, a duplicate-id or
// malformed-pattern rejection (chrome.runtime.lastError) would vanish
// silently and applyMenus would resolve as if the item existed.
function createMenu(properties) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(properties, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

async function applyMenus(settings) {
  await chrome.contextMenus.removeAll();
  if (settings.mode === MODES.OFF) return;

  await createMenu({
    id: MENU_LINK,
    title: 'Open link in Folio (desktop)',
    contexts: ['link'],
    targetUrlPatterns: PDF_MENU_PATTERNS,
  });
  await createMenu({
    id: MENU_PAGE,
    title: 'Open this PDF in Folio (desktop)',
    contexts: ['page'],
    // PDFs we did not intercept, plus the viewer itself once we did. Without
    // the second pattern the entry vanishes on exactly the pages where the
    // extension is working.
    documentUrlPatterns: [...PDF_MENU_PATTERNS, `${viewerUrl()}*`],
  });
}

// --- Toolbar button ---------------------------------------------------------
/**
 * What the toolbar button (and its click) should hand to the desktop app for
 * this tab, given the current mode, or null to disable it.
 *
 * In BROWSER mode a content-type-detected PDF (rule 2) has already been
 * redirected to the viewer by the time anything looks at the tab, so
 * `handoffUrlForTab`'s URL-shape check is enough: what is left either is
 * already showing as the viewer, or ends in `.pdf`. In DESKTOP mode nothing
 * is ever intercepted (`buildRules` installs no rules unless
 * `shouldIntercept`), so there is no way from here to know a PDF was served
 * at a URL that does not look like one -- that needs the response, and
 * nothing inspects responses outside of rule 2, which only exists in BROWSER
 * mode. Rather than disable the button on exactly the pages README.md
 * promises it handles, DESKTOP mode hands off the tab's URL unconditionally,
 * the way this file did before it grew PDF detection: if it turns out not to
 * be a PDF, the desktop app's own fetch reports that.
 *
 * The context menu's "page" entry has the same blind spot in DESKTOP mode --
 * Chrome evaluates its match patterns from the URL alone, before any click --
 * and there is no equivalent fix for it here: broadening its
 * `documentUrlPatterns` to match every page would put a misleading "Open this
 * PDF" entry on pages that are not PDFs at all, worse than the entry
 * sometimes missing.
 */
function actionTarget(tab, settings) {
  if (settings.mode === MODES.OFF) return null;
  if (settings.mode === MODES.DESKTOP) return isHandoffableUrl(tab?.url) ? tab.url : null;
  return handoffUrlForTab(tab?.url, viewerUrl());
}

// The button only does something on a PDF, so it is only enabled on a PDF.
// A button that is always clickable but usually inert is worse than one that
// tells you, before you click, that there is nothing to click.
async function applyActionState(tab, settings) {
  if (!tab?.id) return;
  const target = actionTarget(tab, settings);
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
  // Neither of the above touches the currently active tab's toolbar button;
  // refresh it too, so install, startup, or a settings change do not leave it
  // showing stale state until the user happens to switch tabs.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await applyActionState(tab, settings);
  return settings;
}

// A service worker has no UI of its own to surface a failure in; at minimum,
// log it where chrome://extensions -> service worker -> Inspect will show it,
// rather than let it vanish as an unhandled rejection. updateDynamicRules is
// all-or-nothing (see applyRules) and contextMenus.create can now reject (see
// createMenu), so a failure here can mean the extension is silently not doing
// what its own settings say it should.
function reportApplyError(context, error) {
  console.error(`Folio: failed to apply settings (${context})`, error);
}

// --- Wiring -----------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  applyAll().catch((error) => reportApplyError('onInstalled', error));
});

chrome.runtime.onStartup.addListener(() => {
  applyAll().catch((error) => reportApplyError('onStartup', error));
});

onSettingsChanged(() => {
  applyAll().catch((error) => reportApplyError('onSettingsChanged', error));
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

chrome.action.onClicked.addListener(async (tab) => {
  openInDesktop(actionTarget(tab, await loadSettings()));
});
