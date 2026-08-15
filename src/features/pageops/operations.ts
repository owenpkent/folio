/**
 * The page operations themselves: what a menu item, a shortcut, a drag, or a
 * Delete keypress ends up calling.
 *
 * Every one of them builds a plan, hands it to {@link commitPagePlan}, and lets
 * that do the serialize / mutate / reload dance once. Nothing here talks to
 * pdf-lib or to the engine directly.
 */
import { announce } from '@/a11y/announcer';
import { pushToast } from '@/components/common';
import { getEngine } from '@/core/pdf';
import { resetPageSizes } from '@/core/pdf/pageSizes';
import { useTextEditStore } from '@/features/textedit/store';
import { useSigningStore } from '@/features/signing';
import { reloadEditedBytes } from '@/state/actions';
import { useDocumentMutationStore } from '@/state/documentMutationStore';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { applyPagePlan, PageOpsError } from './mutate';
import {
  capturePageState,
  clearTransientPageState,
  remapPageState,
  restorePageState,
  type PageOpsSnapshot,
  type PageTurns,
} from './pageState';
import { deletePlan, movePlan, nudgePlan, QUARTER_TURN, rotatePlan } from './plans';
import { usePageOpsStore } from './store';
import type { PagePlan } from './types';

const pageWord = (count: number): string => (count === 1 ? 'page' : 'pages');

/**
 * The plan's turns keyed by old 1-based page number, which is the side of the
 * move the sidecar stores are still on when they get remapped.
 */
function turnsByPageNumber(plan: PagePlan): PageTurns | undefined {
  if (!plan.rotateBy) return undefined;
  return new Map(
    Object.entries(plan.rotateBy).map(([index, degrees]) => [Number(index) + 1, degrees]),
  );
}

/**
 * Page operations rewrite the page tree, which breaks any cryptographic
 * signature over the old bytes. Warned once per document, at the first
 * operation, rather than on every drag.
 */
function warnIfSigned(): void {
  const ops = usePageOpsStore.getState();
  if (ops.warnedAboutSignatures) return;
  if (useSigningStore.getState().detected.length === 0) return;
  ops.markSignaturesWarned();
  pushToast(
    'This document is digitally signed. Changing its pages will invalidate its signatures.',
    'info',
  );
}

/**
 * Snapshot, mutate, reload, and move every page-keyed thing to where it now
 * belongs. Returns false when it declined or failed, having said why.
 */
export async function commitPagePlan(plan: PagePlan, announcement: string): Promise<boolean> {
  const ops = usePageOpsStore.getState();
  const mutation = useDocumentMutationStore.getState();
  // Each commit serialises the whole document and reloads it, so a second one
  // starting mid-flight would be reading bytes the first has already
  // replaced -- ops.busy guards a second page op, mutation.inFlight guards
  // every OTHER feature that can also rewrite the document (see
  // documentMutationStore.ts).
  if (ops.busy || mutation.inFlight) return false;
  ops.setBusy(true);
  mutation.begin();
  warnIfSigned();

  let snapshot: PageOpsSnapshot | undefined;
  try {
    const wasOn = useViewerStore.getState().currentPage;
    const before = await getEngine().saveDocument();
    // These bytes stay ours: pdf-lib parses a copy, and only reloadEditedBytes
    // hands an array to pdf.js, which detaches it.
    snapshot = capturePageState(before, useViewerStore.getState().numPages);
    const result = await applyPagePlan({ pdfBytes: before, plan });

    // Persisting the remap (each store's replaceAll writes straight through to
    // localStorage) has to wait until the swap it is describing has actually
    // landed. reloadEditedBytes can still reject after applyPagePlan
    // succeeds, and remapping first would leave every highlight, signature,
    // text box, and OCR page one page ahead of a document that never changed,
    // saved to disk, with nothing in the undo stack to put it back.
    await swapInDocument(result.bytes, result.numPages, wasOn, result.pageMap);
    remapPageState(result.pageMap, turnsByPageNumber(plan));

    usePageOpsStore.getState().pushUndo(snapshot);
    usePageOpsStore.getState().remapSelection(result.pageMap);
    announce(announcement);
    return true;
  } catch (error) {
    // Nothing to put back if the failure happened before the swap, but if
    // swapInDocument itself is what failed, capturePageState's snapshot is
    // the only record of the (still current) sidecar state.
    if (snapshot) restorePageState(snapshot);
    const message =
      error instanceof PageOpsError
        ? error.message
        : 'Could not change the pages of this document.';
    pushToast(message, 'error');
    announce(message, true);
    return false;
  } finally {
    usePageOpsStore.getState().setBusy(false);
    mutation.end();
  }
}

/** Step back one page operation, restoring both the bytes and what was placed on them. */
export async function undoPageOp(): Promise<boolean> {
  const ops = usePageOpsStore.getState();
  const mutation = useDocumentMutationStore.getState();
  if (ops.busy || mutation.inFlight) return false;
  const snapshot = ops.popUndo();
  if (!snapshot) return false;
  ops.setBusy(true);
  mutation.begin();

  try {
    const wasOn = useViewerStore.getState().currentPage;
    // The byte swap first: swapInDocument hands snapshot.bytes to pdf.js,
    // which detaches the buffer, so a snapshot is good for exactly one
    // attempt and there are no bytes left to retry with if this rejects.
    // Restoring the sidecar stores only once it has actually landed keeps a
    // failed attempt from leaving every highlight, signature, text box, and
    // OCR page pointed at a document that never went back.
    await swapInDocument(snapshot.bytes, snapshot.numPages, wasOn, null);
    restorePageState(snapshot);
    usePageOpsStore.getState().clearSelection();
    announce('Page change undone');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not undo the page change.';
    pushToast(message, 'error');
    announce(message, true);
    return false;
  } finally {
    usePageOpsStore.getState().setBusy(false);
    mutation.end();
  }
}

async function swapInDocument(
  bytes: Uint8Array,
  numPages: number,
  wasOn: number,
  pageMap: Map<number, number> | null,
): Promise<void> {
  // A pending placement, an open text-edit session, and a selected image are
  // all aimed at page state that is about to mean something else; see
  // pageState.ts.
  clearTransientPageState();
  // Page ops and text edits keep separate undo stacks bound to the same Mod+z
  // chord (see commands.ts); once this reload lands, the other stack's
  // snapshots describe bytes from before it, and using one would silently
  // discard whatever this swap just did.
  useTextEditStore.getState().clearUndo();

  await reloadEditedBytes(bytes);
  // Page geometry is cached per page number, and the count, the order, and any
  // page's rotation may all have just changed under it.
  resetPageSizes();

  const viewer = useViewerStore.getState();
  viewer.setNumPages(numPages);
  // Follow the page the user was reading. If it was deleted, stay where it sat
  // rather than jumping back to the top of the document.
  viewer.goToPage(pageMap?.get(wasOn) ?? Math.min(wasOn, numPages));

  // Bookmarks resolve to absolute page numbers against the page tree at load
  // time (see loadSource), and a page op is the first thing that can change
  // that tree after load: without this the Outline sidebar keeps navigating
  // to where a bookmark's target used to sit.
  try {
    useDocumentStore.getState().setOutline(await getEngine().getOutline());
  } catch {
    // Best-effort: the page operation itself already succeeded, and a stale
    // outline is a smaller loss than failing it over a sidebar convenience.
  }
}

export async function deleteSelectedPages(): Promise<void> {
  const { selection } = usePageOpsStore.getState();
  if (selection.size === 0) return;

  const plan = deletePlan(useViewerStore.getState().numPages, selection);
  if (!plan) {
    pushToast('A document has to keep at least one page.', 'error');
    announce('A document has to keep at least one page.', true);
    return;
  }

  const count = selection.size;
  await commitPagePlan(plan, `Deleted ${count} ${pageWord(count)}`);
}

/** Shift the selection one place up (`-1`) or down (`+1`). */
export async function nudgeSelection(delta: -1 | 1): Promise<void> {
  const { selection } = usePageOpsStore.getState();
  const plan = nudgePlan(useViewerStore.getState().numPages, selection, delta);
  if (!plan) {
    // Null means the selection is already against that end of the document.
    // PageActionBar disables the button for this, but the keybinding
    // (Alt+ArrowUp/Down) has no such guard, so this still needs to say
    // something rather than do nothing silently.
    announce(`Already at the ${delta === -1 ? 'start' : 'end'} of the document`);
    return;
  }

  const count = selection.size;
  await commitPagePlan(plan, `Moved ${count} ${pageWord(count)} ${delta === -1 ? 'up' : 'down'}`);
}

/**
 * Drop the selection at a gap in the page list. `dropIndex` counts the pages
 * above the gap, so 0 is above the first page.
 */
export async function moveSelectionTo(dropIndex: number): Promise<void> {
  const { selection } = usePageOpsStore.getState();
  if (selection.size === 0) return;

  const numPages = useViewerStore.getState().numPages;
  const plan = movePlan(numPages, selection, dropIndex);
  // A drag that lands where the pages already were is not worth a rewrite of
  // the file, let alone an undo entry.
  if (plan.order.every((source, position) => source === position)) return;

  const count = selection.size;
  await commitPagePlan(plan, `Moved ${count} ${pageWord(count)}`);
}

export async function rotateSelection(direction: -1 | 1): Promise<void> {
  const { selection } = usePageOpsStore.getState();
  const plan = rotatePlan(useViewerStore.getState().numPages, selection, direction * QUARTER_TURN);
  if (!plan) return;

  const count = selection.size;
  await commitPagePlan(
    plan,
    `Rotated ${count} ${pageWord(count)} ${direction === -1 ? 'left' : 'right'}`,
  );
}
