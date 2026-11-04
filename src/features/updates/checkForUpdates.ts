import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';

import { pushToast } from '@/components/common';
import { isTauri } from '@/core/document/openDocument';
import { useDocumentStore } from '@/state/documentStore';

import { forgetOpenDocument, rememberOpenDocument } from './resumeAfterUpdate';

const RESTART_PROMPT = 'Update installed. Restart Folio to finish?';

/**
 * Added to whichever prompt commits to a restart when the open document has
 * been edited in place.
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
 * Whether installing the update is itself the restart.
 *
 * On Windows tauri-plugin-updater hands the NSIS installer the job of
 * restarting Folio and exits this process from inside `downloadAndInstall`
 * (its Windows install path ends in `std::process::exit`), so nothing after
 * that call ever runs there: no restart prompt, and no second chance to
 * record anything. On macOS and Linux the call returns and the app keeps
 * running until `relaunch` is asked for.
 */
function installRestarts(): boolean {
  return /windows/i.test(navigator.userAgent);
}

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

    const restartsOnInstall = installRestarts();
    const edited = useDocumentStore.getState().docVersion > 0;
    const notes = update.body ? `\n\n${update.body}` : '';
    const accepted = await ask(
      `Folio ${update.version} is available (you have ${update.currentVersion}).${notes}` +
        `\n\nDownload and install it now?${restartsOnInstall ? ' Folio restarts to finish.' : ''}` +
        `${restartsOnInstall && edited ? EDITED_WARNING : ''}`,
      {
        title: 'Update available',
        kind: restartsOnInstall && edited ? 'warning' : 'info',
        okLabel: 'Update',
        cancelLabel: 'Later',
      },
    );
    if (!accepted) return;

    // The note goes down before the install, while the process is still ours:
    // where installing is the restart (see installRestarts) this is the only
    // moment it can be written, and accepting the update there is the user's
    // restart decision. Where the call returns, the prompt below refines it:
    // "Later" takes the note back, because that update then lands on some
    // future launch the user starts for their own reasons, and reopening a
    // document from days ago at that point would be a surprise rather than a
    // convenience. See resumeAfterUpdate.ts.
    rememberOpenDocument();
    pushToast(`Downloading Folio ${update.version}...`, 'info');
    try {
      await update.downloadAndInstall();
    } catch (error) {
      // Nothing was installed, so no restart is coming to use the note.
      forgetOpenDocument();
      throw error;
    }

    const restart = await ask(edited ? `${RESTART_PROMPT}${EDITED_WARNING}` : RESTART_PROMPT, {
      title: 'Restart Folio',
      kind: edited ? 'warning' : 'info',
      okLabel: 'Restart now',
      cancelLabel: 'Later',
    });
    if (!restart) {
      forgetOpenDocument();
      return;
    }
    // Written again rather than trusted from before the download: the reader
    // may have turned pages while it ran.
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
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (!silent) pushToast(`Update check failed: ${messageText}`, 'error');
    else console.warn('[updates] check failed:', messageText);
  }
}
