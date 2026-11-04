/**
 * Carrying page-keyed state across a page plan.
 *
 * Everything the user places lives in a per-fingerprint sidecar keyed by page
 * number, so moving or deleting a page silently invalidates it: a highlight on
 * page 7 is still on "page 7" after page 3 is deleted, which is now somebody
 * else's page. This module is the one place that knows the full list, so a new
 * page-keyed store only has to be added here.
 */
import { rotateNormalizedPoint, rotateNormalizedRect } from '@/core/pdf/pageGeometry';
import type { Annotation } from '@/features/annotations/types';
import type { EditItem } from '@/features/editing/types';
import type { OcrPage } from '@/features/ocr/types';
import type { Signature } from '@/features/signatures/types';
// Stores rather than the feature barrels, which also export their components:
// this is orchestration and has no business pulling UI modules in. Same reason
// state/actions.ts reaches past the barrel for placement and textedit.
import { useAnnotationStore } from '@/features/annotations/store';
import { useEditStore } from '@/features/editing/store';
import { useImageEditStore } from '@/features/imageedit/store';
import { useOcrStore } from '@/features/ocr/store';
import { usePlacementStore } from '@/features/placement/store';
import { useLegacySidecarStore } from '@/features/sidecar/legacyStore';
import { useSignatureStore } from '@/features/signatures/store';
import { useTextEditStore } from '@/features/textedit/store';

/** Everything a page operation disturbs, as it was just before it ran. */
export interface PageOpsSnapshot {
  /**
   * The document as it was. These bytes go straight back to the engine on
   * undo, which detaches them, so a snapshot is good for exactly one restore.
   */
  bytes: Uint8Array;
  numPages: number;
  edits: EditItem[];
  annotations: Annotation[];
  signatures: Signature[];
  ocrPages: Record<number, OcrPage>;
  /**
   * How the operation this snapshot precedes moved the pages (old number to
   * new) and turned them, filled in once it has landed. {@link undoPageState}
   * needs both to carry work done since the operation back across it, rather
   * than throwing that work away with the operation.
   */
  pageMap?: Map<number, number>;
  turns?: PageTurns;
}

/**
 * Copied one level deep: the stores replace their collections rather than
 * mutating them, but a snapshot that shares an array with a live store is one
 * refactor away from being silently wrong.
 */
export function capturePageState(bytes: Uint8Array, numPages: number): PageOpsSnapshot {
  return {
    bytes,
    numPages,
    edits: [...useEditStore.getState().edits],
    annotations: [...useAnnotationStore.getState().annotations],
    signatures: [...useSignatureStore.getState().signatures],
    ocrPages: { ...useOcrStore.getState().pages },
  };
}

export function restorePageState(snapshot: PageOpsSnapshot): void {
  useEditStore.getState().replaceAll(snapshot.edits);
  useAnnotationStore.getState().replaceAll(snapshot.annotations);
  useSignatureStore.getState().replaceAll(snapshot.signatures);
  useOcrStore.getState().replaceAll(snapshot.ocrPages);
}

/**
 * Put the sidecar back the way it was before the operation `snapshot`
 * precedes, keeping what the user has placed since.
 *
 * {@link restorePageState} writes the snapshot's collections back wholesale,
 * which is right when nothing has happened since (a commit that failed after
 * capturing) and wrong for an undo: a signature placed, a highlight drawn, or
 * an OCR run finished after the operation is not part of the operation, and a
 * text or image edit in the same position clears this stack rather than let
 * an undo discard it (see clearUndo in store.ts). Those are byte changes with
 * no way back; the sidecar does have one. Everything live is mapped through
 * the operation in reverse, which puts an item placed on the page now
 * numbered 2 back on whichever page that was, and only what sat on a page the
 * operation deleted, which exists nowhere but in the snapshot, comes from it.
 *
 * An item the user removed after the operation stays removed, and an item
 * moved or edited since keeps its new form: the user's later work wins over
 * the copy that was taken before it, as it does everywhere else.
 */
export function undoPageState(snapshot: PageOpsSnapshot): void {
  const { pageMap, turns } = snapshot;
  if (!pageMap) {
    restorePageState(snapshot);
    return;
  }

  // The operation in reverse: new number to old, and each turn undone, keyed
  // by the number the page has NOW, since that is what the live items carry.
  const back = new Map<number, number>();
  for (const [from, to] of pageMap) back.set(to, from);
  let turnsBack: PageTurns | undefined;
  if (turns) {
    turnsBack = new Map();
    for (const [from, degrees] of turns) {
      const now = pageMap.get(from);
      if (now !== undefined) turnsBack.set(now, -degrees);
    }
  }
  // Pages the operation deleted have no entry in the map, and nothing live
  // can be on one: whatever was there is in the snapshot alone.
  const deleted = (pageNumber: number) => !pageMap.has(pageNumber);

  const edits = useEditStore.getState();
  edits.replaceAll([
    ...remapItems(edits.edits, back, turnsBack, turnEdit),
    ...snapshot.edits.filter((item) => deleted(item.pageNumber)),
  ]);

  const annotations = useAnnotationStore.getState();
  annotations.replaceAll([
    ...remapItems(annotations.annotations, back, turnsBack, turnAnnotation),
    ...snapshot.annotations.filter((item) => deleted(item.pageNumber)),
  ]);

  const signatures = useSignatureStore.getState();
  signatures.replaceAll([
    ...remapItems(signatures.signatures, back, turnsBack, turnSignature),
    ...snapshot.signatures.filter((item) => deleted(item.pageNumber)),
  ]);

  const ocr = useOcrStore.getState();
  const ocrPages = remapOcrPages(ocr.pages, back, turnsBack);
  for (const [key, page] of Object.entries(snapshot.ocrPages)) {
    if (deleted(Number(key))) ocrPages[Number(key)] = page;
  }
  ocr.replaceAll(ocrPages);
}

/**
 * Clear page-keyed UI state that a plan cannot carry across and that is not
 * worth restoring on undo either: a pending placement, an image mid-selection,
 * and an open text-edit session are all aimed at a page number, a page's
 * content, or both, and any of those might mean something else entirely one
 * line down (or be gone outright). `usePageOpsStore`'s own selection is exempt
 * -- {@link remapSelection} moves it to where its pages landed instead.
 *
 * Called from both a commit and an undo, so this is the one place that has to
 * remember every page-keyed store that is not one of the ones above, which is
 * what the module doc comment means by knowing the full list.
 */
export function clearTransientPageState(): void {
  usePlacementStore.getState().cancel();
  useImageEditStore.getState().select(null);
  useTextEditStore.getState().endSession();
}

/**
 * Turns applied by a plan, in degrees clockwise, keyed by the page's *old*
 * 1-based number — the same side of the move as everything being remapped.
 */
export type PageTurns = Map<number, number>;

/**
 * Move every placed item to its page's new number, dropping whatever sat on a
 * page the plan deleted, and carrying anything on a turned page round with it.
 */
export function remapPageState(pageMap: Map<number, number>, turns?: PageTurns): void {
  const edits = useEditStore.getState();
  edits.replaceAll(remapItems(edits.edits, pageMap, turns, turnEdit));

  const annotations = useAnnotationStore.getState();
  annotations.replaceAll(remapItems(annotations.annotations, pageMap, turns, turnAnnotation));

  const signatures = useSignatureStore.getState();
  signatures.replaceAll(remapItems(signatures.signatures, pageMap, turns, turnSignature));

  const ocr = useOcrStore.getState();
  ocr.replaceAll(remapOcrPages(ocr.pages, pageMap, turns));

  // Sidecar state saved under this file's pre-0.8.2 key was offered for the
  // page map it opened with, which this just replaced; and the undo snapshot
  // taken a moment ago would write the stores' pre-apply contents straight
  // back over anything applied from now on. The old entries stay where they
  // are and are offered again on the next open.
  useLegacySidecarStore.getState().reset();
}

function turnEdit(item: EditItem, degrees: number): EditItem {
  return { ...item, rect: rotateNormalizedRect(item.rect, degrees) };
}

function turnAnnotation(item: Annotation, degrees: number): Annotation {
  return {
    ...item,
    rects: item.rects.map((rect) => rotateNormalizedRect(rect, degrees)),
    anchor: item.anchor ? rotateNormalizedPoint(item.anchor, degrees) : undefined,
  };
}

function turnSignature(item: Signature, degrees: number): Signature {
  return { ...item, rect: rotateNormalizedRect(item.rect, degrees) };
}

function remapItems<T extends { pageNumber: number }>(
  items: readonly T[],
  pageMap: Map<number, number>,
  turns: PageTurns | undefined,
  turn: (item: T, degrees: number) => T,
): T[] {
  const next: T[] = [];
  for (const item of items) {
    const moved = pageMap.get(item.pageNumber);
    // No entry means the plan deleted that page, and whatever was placed on it
    // goes with it.
    if (moved === undefined) continue;
    const degrees = turns?.get(item.pageNumber) ?? 0;
    const turned = degrees === 0 ? item : turn(item, degrees);
    next.push({ ...turned, pageNumber: moved });
  }
  return next;
}

/** Keyed by page number *and* carrying one, so both sides have to move. */
function remapOcrPages(
  pages: Record<number, OcrPage>,
  pageMap: Map<number, number>,
  turns: PageTurns | undefined,
): Record<number, OcrPage> {
  const next: Record<number, OcrPage> = {};
  for (const [key, page] of Object.entries(pages)) {
    const source = Number(key);
    const moved = pageMap.get(source);
    if (moved === undefined) continue;
    const degrees = turns?.get(source) ?? 0;
    next[moved] = {
      ...page,
      pageNumber: moved,
      words:
        degrees === 0
          ? page.words
          : page.words.map((word) => ({
              ...word,
              rect: rotateNormalizedRect(word.rect, degrees),
            })),
    };
  }
  return next;
}
