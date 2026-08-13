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
import { useOcrStore } from '@/features/ocr/store';
import { useSignatureStore } from '@/features/signatures/store';

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
  edits.replaceAll(
    remapItems(edits.edits, pageMap, turns, (item, turn) => ({
      ...item,
      rect: rotateNormalizedRect(item.rect, turn),
    })),
  );

  const annotations = useAnnotationStore.getState();
  annotations.replaceAll(
    remapItems(annotations.annotations, pageMap, turns, (item, turn) => ({
      ...item,
      rects: item.rects.map((rect) => rotateNormalizedRect(rect, turn)),
      anchor: item.anchor ? rotateNormalizedPoint(item.anchor, turn) : undefined,
    })),
  );

  const signatures = useSignatureStore.getState();
  signatures.replaceAll(
    remapItems(signatures.signatures, pageMap, turns, (item, turn) => ({
      ...item,
      rect: rotateNormalizedRect(item.rect, turn),
    })),
  );

  const ocr = useOcrStore.getState();
  ocr.replaceAll(remapOcrPages(ocr.pages, pageMap, turns));
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
