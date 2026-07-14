import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';

import { pushToast } from '@/components/common';
import { isTauri } from '@/core/document/openDocument';

/**
 * Check GitHub Releases for a newer Folio via tauri-plugin-updater and, if the
 * user agrees, download, install, and relaunch. No-op in the browser build
 * (there is no Tauri shell to update).
 *
 * @param silent When true (the launch check) stay quiet on "up to date" and on
 *   errors so a network hiccup never nags. When false (a manual "Check for
 *   updates" action) report both outcomes.
 */
export async function checkForUpdates(silent = true): Promise<void> {
  if (!isTauri()) return;

  try {
    const update = await check();
    if (!update) {
      if (!silent) pushToast('Folio is up to date', 'success');
      return;
    }

    const notes = update.body ? `\n\n${update.body}` : '';
    const accepted = await ask(
      `Folio ${update.version} is available (you have ${update.currentVersion}).${notes}\n\nDownload and install it now?`,
      { title: 'Update available', kind: 'info', okLabel: 'Update', cancelLabel: 'Later' },
    );
    if (!accepted) return;

    pushToast(`Downloading Folio ${update.version}...`, 'info');
    await update.downloadAndInstall();

    const restart = await ask('Update installed. Restart Folio to finish?', {
      title: 'Restart Folio',
      kind: 'info',
      okLabel: 'Restart now',
      cancelLabel: 'Later',
    });
    if (restart) await relaunch();
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (!silent) pushToast(`Update check failed: ${messageText}`, 'error');
    else console.warn('[updates] check failed:', messageText);
  }
}
