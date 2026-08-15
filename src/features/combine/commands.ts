import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { pickAndReadDocuments } from '@/core/document/openDocument';
import { loadSource } from '@/state/actions';
import { useDocumentStore } from '@/state/documentStore';

import { CombineCancelledError, combinePdfs } from './combineDocuments';
import { useCombineStore } from './store';

/**
 * Shown only when {@link import('./combineDocuments').CombineResult.formsDegraded}
 * is true: two inputs' form fields shared a `/DR` resource key (most often
 * both having their own `/Font` dict) that were not actually the same
 * resource, so the later input's mapping was dropped in favor of the
 * earlier one's. `formsMerged` alone is not the trigger -- it is true for
 * every clean forms merge too, and warning on that would just train the
 * user to dismiss it.
 */
const FORMS_DEGRADED_WARNING =
  'Form fields were combined, but some appearance resources conflicted between the source files. Check the fields in the combined document before relying on them.';

/**
 * Prompt for one or more PDFs and add them to the pending combine list.
 * Returns how many files were staged (0 on cancel or failure): the caller
 * uses that to decide whether there is anything worth announcing.
 *
 * A file the OS refuses to hand over (permission denied, mid-pick removal)
 * must not take the whole batch down with it: without the try/catch, one bad
 * file among a multi-select made this reject, and neither the good files nor
 * an error ever reached the store.
 */
export async function addFilesViaPicker(): Promise<number> {
  try {
    const sources = await pickAndReadDocuments();
    if (sources.length === 0) return 0;
    useCombineStore
      .getState()
      .addFiles(
        sources.map((source) => ({ name: source.name ?? 'Untitled.pdf', bytes: source.data })),
      );
    return sources.length;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Could not read one or more of those files';
    useCombineStore.getState().setError(message);
    announce(`Could not add files: ${message}`, true);
    return 0;
  }
}

/** Open the combine modal and immediately prompt for the first batch of files. */
export async function openCombineModal(): Promise<void> {
  useCombineStore.getState().open();
  await addFilesViaPicker();
}

/**
 * True from the moment a merge starts until its cleanup finishes. The
 * authoritative guard against two runs overlapping: `store.busy` on its own
 * is not, because dismissing the modal while busy only *requests*
 * cancellation (see {@link CombineModal}) -- the merge keeps running in the
 * background until it next polls `isCancelled`, and closing also resets
 * `busy` to false. Without a guard that survives that reset, a second run
 * could start over a first one that is still winding down, and whichever one
 * finishes last would win, overwriting the other's result, error, or close.
 */
let inFlight = false;

/**
 * Merge the pending files and load the result into the viewer, as a new,
 * pathless document -- Save then prompts for a location rather than writing
 * over any one of the inputs.
 */
export async function runCombine(): Promise<void> {
  if (inFlight) return;
  const store = useCombineStore.getState();
  if (store.files.length < 2) {
    store.setError('Add at least two PDFs to combine');
    return;
  }

  inFlight = true;
  // Snapshotted now, not read again until the merge is done: the row controls
  // that could change this list are disabled for as long as `busy` is true
  // (see CombineModal), so this stays the list the user actually saw.
  const inputs = store.files.map((f) => ({ name: f.name, bytes: f.bytes, doc: f.doc }));
  const total = inputs.length;

  // Also clears cancelRequested: a run that was cancelled leaves the modal
  // open with nothing else resetting that flag (see the field's own doc
  // comment in store.ts), and without this a second Combine click would
  // poll isCancelled() below and see it still true from the last run,
  // cancelling itself before doing any work.
  store.startRun(total);
  try {
    const result = await combinePdfs(inputs, {
      onProgress: (done) => useCombineStore.getState().setProgress(done, total),
      isCancelled: () => useCombineStore.getState().cancelRequested,
    });

    await loadSource({ kind: 'bytes', data: result.bytes, name: 'combined.pdf' });
    // loadSource never rejects -- it catches its own failures into
    // doc.setError and resolves normally -- so a failed load has to be
    // noticed here instead, or this proceeds to announce success over an
    // error state.
    const doc = useDocumentStore.getState();
    if (doc.status === 'error') {
      throw new Error(doc.error ?? 'Could not open the combined document');
    }

    useCombineStore.getState().close();
    if (result.formsDegraded) {
      // A real, if narrow, warning: something was actually dropped. Kept
      // distinct from the plain success toast (kind 'info' rather than
      // 'success') so it reads as worth a second look, not as an error.
      pushToast(`Combined. ${FORMS_DEGRADED_WARNING}`, 'info');
      announce(`Combined ${total} documents. ${FORMS_DEGRADED_WARNING}`);
    } else {
      pushToast('Combined', 'success');
      // Informational only when forms merged cleanly: nothing was lost, so
      // this says what happened without asking the user to go check anything.
      announce(`Combined ${total} documents${result.formsMerged ? ', including form fields' : ''}`);
    }
  } catch (error) {
    if (error instanceof CombineCancelledError) {
      // A user action, not a failure -- like print's own cancel, this must
      // not raise an error. The modal stays open (nothing called close())
      // with its staged list intact, so the user can pick up where they left
      // off; only the busy/progress state needs clearing, in the finally
      // below.
    } else {
      const message = error instanceof Error ? error.message : 'Could not combine these PDFs';
      useCombineStore.getState().setError(message);
      announce(`Could not combine: ${message}`, true);
    }
  } finally {
    inFlight = false;
    useCombineStore.getState().endRun();
  }
}

let registered = false;

/** Register the combine command. Idempotent. */
export function registerCombineCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'file.combine',
    title: 'Combine PDFs…',
    category: 'File',
    run: () => openCombineModal(),
  });
}
