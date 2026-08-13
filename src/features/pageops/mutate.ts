/**
 * Applying a page plan to PDF bytes.
 *
 * Everything the user does to the page list — dragging a thumbnail, deleting a
 * selection, turning a page — is expressed as a `PagePlan` and committed here in
 * one pass, following the same serialize/mutate/live-reload pipeline the text
 * and image editors use.
 *
 * Reordering happens inside the existing document rather than by copying pages
 * into a fresh one. `PDFDocument.copyPages` drops catalog-level data (the
 * outline, the AcroForm, document metadata), and losing a document's bookmarks
 * because the user moved page 4 above page 3 is not a trade worth making.
 */
import { PDFArray, PDFDict, PDFName, PDFRef, PDFDocument, degrees, type PDFPage } from 'pdf-lib';

import { sweepDroppedPages } from './gc';
import type { ApplyPagePlanParams, PageOpsErrorCode, PagePlan, PagePlanResult } from './types';

export class PageOpsError extends Error {
  readonly code: PageOpsErrorCode;

  constructor(code: PageOpsErrorCode, message: string) {
    super(message);
    this.name = 'PageOpsError';
    this.code = code;
  }
}

export async function applyPagePlan({
  pdfBytes,
  plan,
}: ApplyPagePlanParams): Promise<PagePlanResult> {
  const doc = await PDFDocument.load(pdfBytes);
  const sourcePages = doc.getPages();
  validatePlan(plan, sourcePages.length);

  const sourceRefs = sourcePages.map((page) => page.ref);

  rotatePages(sourcePages, plan.rotateBy);

  const kept = new Set(plan.order);
  const droppedIndices = sourceRefs.map((_, index) => index).filter((index) => !kept.has(index));

  // Read the dropped pages' annotations before the reorder, while the plan's
  // indices still address the document.
  const droppedAnnots = collectAnnots(sourcePages, droppedIndices);

  reorder(doc, plan.order, sourceRefs, sourcePages);

  if (droppedIndices.length > 0) {
    pruneAcroForm(doc, droppedAnnots);
    const droppedPages = droppedIndices.map((index) => sourceRefs[index]);
    // The sweep is told about more than the pages themselves. A page's own
    // annotations and the structure elements describing them are reachable by
    // paths that never touch the page object (`/AcroForm /Fields`, and
    // `/StructTreeRoot` -> `/K` -> `/OBJR` -> `/Obj`), so refusing to walk
    // through the page alone would keep a deleted page's filled field values,
    // their appearance streams, and the `/ActualText` describing them alive on
    // somebody else's account.
    sweepDroppedPages(doc.context, [
      ...droppedPages,
      ...droppedAnnots,
      ...doomedStructElements(doc, new Set(droppedPages)),
    ]);
  }

  const bytes = await doc.save({ updateFieldAppearances: false });
  await verifyResult(bytes, plan.order.length);
  return { bytes, numPages: plan.order.length, pageMap: buildPageMap(plan.order) };
}

/**
 * Re-open the result before handing it back.
 *
 * Page operations are the only thing in the app that *deletes* indirect objects
 * (see gc.ts), and their output can be written straight over the user's own file
 * by Save. An over-eager sweep would therefore destroy the original, and the
 * export path's `isPlausiblePdf` check only looks for a `%PDF-` header, which a
 * document with a shredded object graph still has. Parsing it once here costs
 * one pass over bytes that were just serialised, and turns silent corruption
 * into a refused operation with the document untouched.
 */
export async function verifyResult(bytes: Uint8Array, expectedPages: number): Promise<void> {
  let pageCount: number;
  try {
    pageCount = (await PDFDocument.load(bytes)).getPageCount();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PageOpsError(
      'unreadable-result',
      `The rewritten document could not be read back, so it was not applied (${detail}).`,
    );
  }

  if (pageCount !== expectedPages) {
    throw new PageOpsError(
      'unreadable-result',
      `The rewritten document has ${pageCount} pages instead of ${expectedPages}, so it was not applied.`,
    );
  }
}

function validatePlan(plan: PagePlan, sourceCount: number): void {
  if (plan.order.length === 0) {
    throw new PageOpsError('empty-plan', 'A document has to keep at least one page.');
  }

  const seen = new Set<number>();
  for (const index of plan.order) {
    assertPageIndex(index, sourceCount);
    if (seen.has(index)) {
      throw new PageOpsError('duplicate-page', `Page ${index + 1} appears twice in the plan.`);
    }
    seen.add(index);
  }

  for (const [key, turn] of Object.entries(plan.rotateBy ?? {})) {
    assertPageIndex(Number(key), sourceCount);
    if (!Number.isInteger(turn) || turn % 90 !== 0) {
      throw new PageOpsError('bad-rotation', `${turn} is not a whole number of quarter turns.`);
    }
  }
}

function assertPageIndex(index: number, sourceCount: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= sourceCount) {
    throw new PageOpsError(
      'page-out-of-range',
      `Page ${index + 1} is out of range (the document has ${sourceCount} pages).`,
    );
  }
}

function rotatePages(pages: PDFPage[], rotateBy: PagePlan['rotateBy']): void {
  for (const [key, turn] of Object.entries(rotateBy ?? {})) {
    if (turn % 360 === 0) continue;
    const page = pages[Number(key)];
    // getRotation() resolves /Rotate through the page tree, so a page that
    // inherits its rotation turns from where it actually sits, not from zero.
    page.setRotation(degrees(normalizeAngle(page.getRotation().angle + turn)));
  }
}

function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/**
 * Rearrange the page tree so it holds `order`, then drop whatever is left.
 */
function reorder(
  doc: PDFDocument,
  order: number[],
  sourceRefs: PDFRef[],
  sourcePages: PDFPage[],
): void {
  // A mirror of the page tree's ref order, maintained by hand. pdf-lib's
  // removePage does not invalidate the document's page cache the way insertPage
  // does, so getPages() reports a stale list the moment a page comes out;
  // tracking the order here keeps this loop off that path entirely.
  const current = [...sourceRefs];

  for (let target = 0; target < order.length; target += 1) {
    const wantedIndex = order[target];
    const wanted = sourceRefs[wantedIndex];
    const at = current.indexOf(wanted);
    if (at === target) continue;

    doc.removePage(at);
    current.splice(at, 1);
    doc.insertPage(target, sourcePages[wantedIndex]);
    current.splice(target, 0, wanted);
  }

  // Placing every kept page in turn leaves the dropped ones bunched at the tail,
  // because each iteration only ever pulls pages forward from beyond `target`.
  for (let index = current.length - 1; index >= order.length; index -= 1) {
    doc.removePage(index);
  }
}

function collectAnnots(pages: PDFPage[], indices: number[]): Set<PDFRef> {
  const annots = new Set<PDFRef>();
  for (const index of indices) {
    const list = pages[index].node.Annots();
    if (!list) continue;
    for (const item of list.asArray()) {
      if (item instanceof PDFRef) annots.add(item);
    }
  }
  return annots;
}

/**
 * Drop form fields whose every widget sat on a page the plan removed.
 *
 * `/AcroForm /Fields` reaches its widgets directly, so without this the sweep
 * would keep a deleted page's annotations alive on the form's account, and the
 * document would carry a field with nothing to render it on.
 */
function pruneAcroForm(doc: PDFDocument, droppedAnnots: Set<PDFRef>): void {
  if (droppedAnnots.size === 0) return;
  const fields = doc.catalog.AcroForm()?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return;
  pruneFieldList(doc, fields, droppedAnnots, new Set<PDFRef>());
}

function pruneFieldList(
  doc: PDFDocument,
  fields: PDFArray,
  droppedAnnots: Set<PDFRef>,
  seen: Set<PDFRef>,
): void {
  for (let index = fields.size() - 1; index >= 0; index -= 1) {
    const ref = fields.get(index);
    if (ref instanceof PDFRef && isDeadField(doc, ref, droppedAnnots, seen)) fields.remove(index);
  }
}

function isDeadField(
  doc: PDFDocument,
  ref: PDFRef,
  droppedAnnots: Set<PDFRef>,
  seen: Set<PDFRef>,
): boolean {
  // A field with a single widget is usually merged into one dict, so the field
  // ref is the annotation ref.
  if (droppedAnnots.has(ref)) return true;
  // Guards against a malformed document whose /Kids cycle back on themselves.
  if (seen.has(ref)) return false;
  seen.add(ref);

  const kids = doc.context.lookupMaybe(ref, PDFDict)?.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (!kids) return false;

  pruneFieldList(doc, kids, droppedAnnots, seen);
  return kids.size() === 0;
}

/**
 * Structure elements that describe only a dropped page.
 *
 * A tagged PDF (Acrobat, Word's accessible export, InDesign) carries a parallel
 * tree of `/StructElem` nodes over the page content, and a leaf node holds the
 * `/Alt` and `/ActualText` for the content it tags. Scrubbing its `/Pg` would
 * leave that text in the file describing a page nobody can see any more, so the
 * element goes with the page instead.
 *
 * Only leaves are taken. A node with structure-element children is a container
 * whose children may sit on pages that are staying, and dropping it would take
 * them with it; it keeps its place and loses its dangling `/Pg` to the scrub.
 */
function doomedStructElements(doc: PDFDocument, droppedPages: Set<PDFRef>): PDFRef[] {
  const root = doc.catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict);
  if (!root) return [];

  const doomed: PDFRef[] = [];
  const seen = new Set<PDFRef>();
  const stack = structKids(doc, root);

  while (stack.length > 0) {
    const ref = stack.pop() as PDFRef;
    // Guards against a malformed tree whose nodes point back at each other.
    if (seen.has(ref)) continue;
    seen.add(ref);

    const element = doc.context.lookupMaybe(ref, PDFDict);
    if (!element) continue;

    let hasElementChild = false;
    for (const kid of structKids(doc, element)) {
      // `/S` (the structure type) is what separates a real structure element
      // from the `/OBJR` and `/MCR` leaves that point at content.
      if (doc.context.lookupMaybe(kid, PDFDict)?.get(PDFName.of('S'))) {
        hasElementChild = true;
        stack.push(kid);
      }
    }

    const page = element.get(PDFName.of('Pg'));
    if (!hasElementChild && page instanceof PDFRef && droppedPages.has(page)) doomed.push(ref);
  }

  return doomed;
}

/** The indirect children of a structure node, whatever shape its `/K` takes. */
function structKids(doc: PDFDocument, node: PDFDict): PDFRef[] {
  const kids = node.get(PDFName.of('K'));
  if (!kids) return [];
  // `/K` is a single kid, an array of them, or a reference to either.
  const array = doc.context.lookupMaybe(kids, PDFArray);
  if (array) return array.asArray().filter((kid): kid is PDFRef => kid instanceof PDFRef);
  return kids instanceof PDFRef ? [kids] : [];
}

function buildPageMap(order: number[]): Map<number, number> {
  const pageMap = new Map<number, number>();
  order.forEach((sourceIndex, position) => pageMap.set(sourceIndex + 1, position + 1));
  return pageMap;
}
