// The only place that touches chrome.storage. Everything else works with plain
// settings objects, which is what keeps settings.js unit testable.

import { DEFAULTS, normalizeSettings } from './settings.js';

const KEY = 'settings';

/**
 * Settings live in `sync` so they follow the user between machines, which is
 * the behaviour people expect from a preference this small. Reads are
 * normalized on the way out: sync storage can hold whatever an older or newer
 * version of the extension wrote.
 */
export async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get(KEY);
    return normalizeSettings(stored?.[KEY]);
  } catch {
    // Sync storage can fail (quota, or sync disabled by policy). A broken read
    // must not leave the extension without settings.
    return normalizeSettings(DEFAULTS);
  }
}

/**
 * Normalize and persist. Returns the normalized settings that were actually
 * written, so a caller that wants to show the user what was stored (rather
 * than what they typed) does not have to normalize a second time itself.
 *
 * Not wrapped in a try/catch here the way `loadSettings` is: `chrome.storage`
 * can reject this (quota, or sync disabled by policy), and unlike a read,
 * there is no safe fallback to substitute for a write that did not happen --
 * the caller has to know it failed. `options.js` is the only caller today.
 */
export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.sync.set({ [KEY]: normalized });
  return normalized;
}

/** Call `fn` with the new settings whenever they change, from any surface. */
export function onSettingsChanged(fn) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[KEY]) return;
    fn(normalizeSettings(changes[KEY].newValue));
  });
}
