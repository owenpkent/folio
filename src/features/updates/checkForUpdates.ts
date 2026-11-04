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

/** Read at each prompt rather than once: the reader can edit while the download runs. */
function editedInPlace(): boolean {
  return useDocumentStore.getState().docVersion > 0;
}

/**
 * Whether installing the update is itself the restart.
 *
 * On Windows tauri-plugin-updater hands the NSIS installer the job of
 * restarting Folio and exits this process from inside `install` (its Windows
 * install path ends in `std::process::exit`), so nothing after that call ever
 * runs there: no restart prompt, and no second chance to record anything. On
 * macOS and Linux the call returns and the app keeps running until `relaunch`
 * is asked for.
 */
function installRestarts(): boolean {
  return /windows/i.test(navigator.userAgent);
}

/**
 * Check GitHub Releases for a newer Folio via tauri-plugin-updater and, if the
 * user agrees, download, install, and relaunch. No-op in the browser build
 * (there is no Tauri shell to update).
 *
 * The resume note (see resumeAfterUpdate.ts) is written at the last moment
 * before the process can go away, never earlier: the download can take a
 * while, the window stays usable through it, and a note taken before it would
 * reopen whatever was open then, including a document the reader closed or
 * swapped out in the meantime, or on a launch after an ordinary quit mid
 * download, when no restart ever happened. So the download runs first with
 * nothing recorded; where installing is the restart the note goes down right
 * before `install`, and where it is not, only once the reader has chosen
 * "Restart now".
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
    const warnedAtAccept = restartsOnInstall && editedInPlace();
    const notes = update.body ? `\n\n${update.body}` : '';
    const accepted = await ask(
      `Folio ${update.version} is available (you have ${update.currentVersion}).${notes}` +
        `\n\nDownload and install it now?${restartsOnInstall ? ' Folio restarts to finish.' : ''}` +
        `${warnedAtAccept ? EDITED_WARNING : ''}`,
      {
        title: 'Update available',
        kind: warnedAtAccept ? 'warning' : 'info',
        okLabel: 'Update',
        cancelLabel: 'Later',
      },
    );
    if (!accepted) return;

    pushToast(`Downloading Folio ${update.version}...`, 'info');
    await update.download();

    if (restartsOnInstall) {
      // Accepting the update was the restart decision, but the warning that
      // went with it described the document as it was then. An edit made
      // during the download is about to be thrown away by a restart the
      // reader has not been told about, so it gets its own question.
      if (!warnedAtAccept && editedInPlace()) {
        const proceed = await ask(`Folio ${update.version} is downloaded.${EDITED_WARNING}`, {
          title: 'Install update',
          kind: 'warning',
          okLabel: 'Install and restart',
          cancelLabel: 'Later',
        });
        if (!proceed) return;
      }
      // The last moment this process is ours: what is open right now is what
      // comes back, and nothing is recorded if nothing is.
      rememberOpenDocument();
    }
    try {
      await update.install();
    } catch (error) {
      // Nothing was installed, so no restart is coming to use the note.
      forgetOpenDocument();
      throw error;
    }

    const edited = editedInPlace();
    const restart = await ask(edited ? `${RESTART_PROMPT}${EDITED_WARNING}` : RESTART_PROMPT, {
      title: 'Restart Folio',
      kind: edited ? 'warning' : 'info',
      okLabel: 'Restart now',
      cancelLabel: 'Later',
    });
    if (!restart) {
      // Choosing "Later" means the update lands on some future launch the
      // reader starts for their own reasons, and reopening a document from
      // days ago at that point would be a surprise rather than a convenience.
      forgetOpenDocument();
      return;
    }
    rememberOpenDocument();
    try {
      await relaunch();
    } catch (error) {
      // Still running, so that restart never happened and the note now
      // describes one that never will. Left in place it would reopen the
      // document on whatever launch the user starts next. Rethrown so the
      // outer handler still reports the failure.
      forgetOpenDocument();
      throw error;
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (!silent) pushToast(`Update check failed: ${messageText}`, 'error');
    else console.warn('[updates] check failed:', messageText);
  }
}
