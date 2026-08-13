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
import { usePlacementStore } from '@/features/placement/store';
import { useSigningStore } from '@/features/signing';
import { reloadEditedBytes } from '@/state/actions';
import { useViewerStore } from '@/state/viewerStore';

import { applyPagePlan, PageOpsError } from './mutate';
import { capturePageState, remapPageState, restorePageState, type PageTurns } from './pageState';
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
  // Each commit serialises the whole document and reloads it, so a second one
  // starting mid-flight would be reading bytes the first has already replaced.
  if (ops.busy) return false;
  ops.setBusy(true);
  warnIfSigned();

  try {
    const wasOn = useViewerStore.getState().currentPage;
    const before = await getEngine().saveDocument();
    // These bytes stay ours: pdf-lib parses a copy, and only reloadEditedBytes
    // hands an array to pdf.js, which detaches it.
    const snapshot = capturePageState(before, useViewerStore.getState().numPages);
    const result = await applyPagePlan({ pdfBytes: before, plan });

    remapPageState(result.pageMap, turnsByPageNumber(plan));
    await swapInDocument(result.bytes, result.numPages, wasOn, result.pageMap);

    usePageOpsStore.getState().pushUndo(snapshot);
    usePageOpsStore.getState().remapSelection(result.pageMap);
    announce(announcement);
    return true;
  } catch (error) {
    const message =
      error instanceof PageOpsError
        ? error.message
        : 'Could not change the pages of this document.';
    announce(message, true);
    return false;
  } finally {
    usePageOpsStore.getState().setBusy(false);
  }
}

/** Step back one page operation, restoring both the bytes and what was placed on them. */
export async function undoPageOp(): Promise<boolean> {
  const ops = usePageOpsStore.getState();
  if (ops.busy) return false;
  const snapshot = ops.popUndo();
  if (!snapshot) return false;
  ops.setBusy(true);

  try {
    restorePageState(snapshot);
    const wasOn = useViewerStore.getState().currentPage;
    await swapInDocument(snapshot.bytes, snapshot.numPages, wasOn, null);
    usePageOpsStore.getState().clearSelection();
    announce('Page change undone');
    return true;
  } finally {
    usePageOpsStore.getState().setBusy(false);
  }
}

async function swapInDocument(
  bytes: Uint8Array,
  numPages: number,
  wasOn: number,
  pageMap: Map<number, number> | null,
): Promise<void> {
  // A pending placement is aimed at a page number that is about to mean
  // something else.
  usePlacementStore.getState().cancel();

  await reloadEditedBytes(bytes);
  // Page geometry is cached per page number, and the count, the order, and any
  // page's rotation may all have just changed under it.
  resetPageSizes();

  const viewer = useViewerStore.getState();
  viewer.setNumPages(numPages);
  // Follow the page the user was reading. If it was deleted, stay where it sat
  // rather than jumping back to the top of the document.
  viewer.goToPage(pageMap?.get(wasOn) ?? Math.min(wasOn, numPages));
}

export async function deleteSelectedPages(): Promise<void> {
  const { selection } = usePageOpsStore.getState();
  if (selection.size === 0) return;

  const plan = deletePlan(useViewerStore.getState().numPages, selection);
  if (!plan) {
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
  // Null means the selection is already against that end of the document.
  if (!plan) return;

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
