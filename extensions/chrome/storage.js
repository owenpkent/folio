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

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ [KEY]: normalizeSettings(settings) });
}

/** Call `fn` with the new settings whenever they change, from any surface. */
export function onSettingsChanged(fn) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[KEY]) return;
    fn(normalizeSettings(changes[KEY].newValue));
  });
}
