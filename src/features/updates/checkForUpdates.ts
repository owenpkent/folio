import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';

import { pushToast } from '@/components/common';
import { isTauri } from '@/core/document/openDocument';
import { useDocumentStore } from '@/state/documentStore';

import { forgetOpenDocument, rememberOpenDocument } from './resumeAfterUpdate';

const RESTART_PROMPT = 'Update installed. Restart Folio to finish?';

/**
 * Added to the restart prompt when the open document has been edited in place.
 *
 * `docVersion` counts the in-place byte rewrites since the document was loaded
 * -- text edits, image edits, page operations, all of which funnel through
 * `reloadEditedBytes` -- and `setLoaded` resets it. Non-zero therefore means
 * the bytes in memory are not the bytes on disk, and the resume note reopens
 * the file, not the memory. Without this the reader gets their document back
 * at the same page with the edits quietly gone, which reads as a session that
 * survived rather than one that was lost.
 *
 * It over-warns by one case: saving in place does not reset the counter, so
 * someone who just saved is told about work that is in fact on disk. The
 * wording holds either way, and erring toward the warning is the right side to
 * be wrong on.
 */
const EDITED_WARNING =
  '\n\nThe open document has been edited in place. Restarting reopens it from the file on disk, so any change you have not saved will be lost.';

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

    const edited = useDocumentStore.getState().docVersion > 0;
    const restart = await ask(edited ? `${RESTART_PROMPT}${EDITED_WARNING}` : RESTART_PROMPT, {
      title: 'Restart Folio',
      kind: edited ? 'warning' : 'info',
      okLabel: 'Restart now',
      cancelLabel: 'Later',
    });
    if (restart) {
      // Leave the note before the process goes away, and only on the branch
      // that actually restarts: choosing "Later" means the update lands on
      // some future launch the user starts for their own reasons, and
      // reopening a document from days ago at that point would be a surprise
      // rather than a convenience. See resumeAfterUpdate.ts.
      rememberOpenDocument();
      try {
        await relaunch();
      } catch (error) {
        // Still running, so that restart never happened and the note now
        // describes one that never will. Left in place it would reopen the
        // document on whatever launch the user starts next, which is the
        // surprise the "only on the restart branch" rule above exists to
        // avoid. Rethrown so the outer handler still reports the failure.
        forgetOpenDocument();
        throw error;
      }
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (!silent) pushToast(`Update check failed: ${messageText}`, 'error');
    else console.warn('[updates] check failed:', messageText);
  }
}
