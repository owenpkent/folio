// Options page controller. All the interesting logic lives in settings.js; this
// file is the thin bridge between that and the form.

import { formatSiteList, normalizeSettings, parseSiteList } from './settings.js';
import { loadSettings, saveSettings } from './storage.js';

const form = document.getElementById('form');
const excluded = document.getElementById('excluded');
const status = document.getElementById('status');

function announce(message) {
  // Re-setting identical text does not always re-trigger a live region, so clear
  // first. Without this, saving twice in a row is silent for a screen reader.
  status.textContent = '';
  requestAnimationFrame(() => {
    status.textContent = message;
  });
}

async function render() {
  const settings = await loadSettings();
  const radio = form.querySelector(`input[name="mode"][value="${settings.mode}"]`);
  if (radio) radio.checked = true;
  excluded.value = formatSiteList(settings.excludedSites);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = normalizeSettings({
    mode: new FormData(form).get('mode'),
    excludedSites: parseSiteList(excluded.value),
  });
  await saveSettings(settings);

  // Show the user what was actually stored, not what they typed: the list is
  // normalized (deduplicated, scheme and path stripped), and silently changing
  // their input underneath them would be worse than showing the result.
  excluded.value = formatSiteList(settings.excludedSites);

  const count = settings.excludedSites.length;
  announce(`Saved. ${count === 0 ? 'No sites excluded.' : `${count} site${count === 1 ? '' : 's'} excluded.`}`);
});

void render();
