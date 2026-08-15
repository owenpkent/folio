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
import {
  degrees,
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFDocument,
  type PDFObject,
  type PDFPage,
} from 'pdf-lib';

import { normalizeAngle } from '@/core/pdf/pageGeometry';

import { findDanglingRefs, sweepDroppedPages } from './gc';
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

  renumberPageLabels(doc, plan.order);
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
  // The graph-integrity pass below is only worth its cost on the path that can
  // actually shred the object graph: a plan that only reorders or rotates
  // never deletes an indirect object.
  await verifyResult(bytes, plan.order.length, droppedIndices.length > 0);
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
export async function verifyResult(
  bytes: Uint8Array,
  expectedPages: number,
  checkGraph = false,
): Promise<void> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PageOpsError(
      'unreadable-result',
      `The rewritten document could not be read back, so it was not applied (${detail}).`,
    );
  }

  const pageCount = doc.getPageCount();
  if (pageCount !== expectedPages) {
    throw new PageOpsError(
      'unreadable-result',
      `The rewritten document has ${pageCount} pages instead of ${expectedPages}, so it was not applied.`,
    );
  }

  // Page count alone only exercises the page tree, the structure the sweep is
  // least likely to get wrong: a corrupted /ParentTree pairing or an orphaned
  // structure element leaves it untouched. Re-walk the graph the sweep just
  // produced and refuse a result that leaves anything reachable pointing at an
  // object that no longer exists — which also covers every surviving page's
  // /Resources, since those are reached the same way as everything else.
  if (checkGraph) {
    const dangling = findDanglingRefs(doc.context);
    if (dangling.length > 0) {
      throw new PageOpsError(
        'unreadable-result',
        `The rewritten document has ${dangling.length} broken reference${dangling.length === 1 ? '' : 's'} after removing pages, so it was not applied.`,
      );
    }
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
    // normalizeAngle rounds to the nearest quarter turn rather than
    // truncating, so a page whose existing /Rotate is not itself a multiple
    // of 90 (malformed, or just a tool that did not care) still lands on a
    // value setRotation accepts instead of throwing and failing every rotate
    // on that document.
    page.setRotation(degrees(normalizeAngle(page.getRotation().angle + turn)));
  }
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
  // insertLeafNode grafts a moved page onto whichever intermediate /Pages
  // node covers its new index, and setParent then repoints the page's whole
  // inheritance chain at that node. A page that relied on an ancestor for its
  // Resources, MediaBox, CropBox, or Rotate would silently start inheriting
  // the new parent's instead the moment that happens, so every kept page's
  // resolved values are pinned onto it directly before anything moves.
  for (const sourceIndex of order) materializeInheritedAttributes(sourcePages[sourceIndex]);

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

/**
 * Copy a page's resolved Resources, MediaBox, CropBox, and Rotate — pdf-lib's
 * own `PDFPageLeaf.InheritableEntries` — directly onto it, so it no longer
 * depends on which `/Pages` node it happens to sit under for any of them.
 */
function materializeInheritedAttributes(page: PDFPage): void {
  const node = page.node;

  const resources = node.Resources();
  if (resources) node.set(PDFName.of('Resources'), resources);

  const mediaBox = node.MediaBox();
  if (mediaBox) node.set(PDFName.of('MediaBox'), mediaBox);

  const cropBox = node.CropBox();
  if (cropBox) node.set(PDFName.of('CropBox'), cropBox);

  const rotate = node.Rotate();
  if (rotate) node.set(PDFName.of('Rotate'), rotate);
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
  // `/Pg` is inheritable (PDF 32000-1 14.7.4.2): InDesign and LibreOffice set
  // it once on a `/Sect` or `/Document` container and leave the leaves under
  // it without one, so each stack entry carries the nearest ancestor's page
  // down for a leaf that omits it.
  const stack: Array<{ ref: PDFRef; inheritedPg: PDFRef | undefined }> = structKids(doc, root).map(
    (ref) => ({ ref, inheritedPg: undefined }),
  );

  while (stack.length > 0) {
    const { ref, inheritedPg } = stack.pop() as { ref: PDFRef; inheritedPg: PDFRef | undefined };
    // Guards against a malformed tree whose nodes point back at each other.
    if (seen.has(ref)) continue;
    seen.add(ref);

    const element = doc.context.lookupMaybe(ref, PDFDict);
    if (!element) continue;

    const ownPg = element.get(PDFName.of('Pg'));
    const page = ownPg instanceof PDFRef ? ownPg : inheritedPg;

    let hasElementChild = false;
    for (const kid of structKids(doc, element)) {
      // `/S` (the structure type) is what separates a real structure element
      // from the `/OBJR` and `/MCR` leaves that point at content.
      if (doc.context.lookupMaybe(kid, PDFDict)?.get(PDFName.of('S'))) {
        hasElementChild = true;
        stack.push({ ref: kid, inheritedPg: page });
      }
    }

    if (!hasElementChild && page instanceof PDFRef && droppedPages.has(page)) doomed.push(ref);
  }

  return doomed;
}

/** The indirect children of a structure node, whatever shape its `/K` takes. */
function structKids(doc: PDFDocument, node: PDFDict): PDFRef[] {
  const kids = node.get(PDFName.of('K'));
  if (!kids) return [];
  // `/K` is a single kid, an array of them, or a reference to either — and it
  // may also be a direct MCID (a bare integer) or an inline `/MCR`/`/OBJR`
  // content reference, neither of which is a structure-element kid.
  // `lookupMaybe` throws rather than returning undefined when the object
  // exists but is the wrong type, which every one of those non-array shapes
  // is, so resolve by hand instead of trusting it to fail soft: Word and
  // Acrobat both write `/K` as a single indirect ref, which used to throw here
  // and make every delete on those documents fail.
  const resolved = kids instanceof PDFRef ? doc.context.lookup(kids) : kids;
  if (resolved instanceof PDFArray) {
    return resolved.asArray().filter((kid): kid is PDFRef => kid instanceof PDFRef);
  }
  return kids instanceof PDFRef ? [kids] : [];
}

/**
 * Renumber `/Root /PageLabels`, if there is one, to match `order`.
 *
 * It is a number tree exactly like `/StructTreeRoot /ParentTree`: a flat
 * `[pageIndex, labelDict, pageIndex, labelDict, …]` array (or one sharded
 * across `/Kids`), read by a viewer as "starting at this page index, use this
 * numbering style until the next entry". A plan can renumber, reorder, or drop
 * pages out from under it, and none of that is a reason to fail the plan
 * itself — page labels are cosmetic — so any unexpected shape here leaves the
 * existing (now stale) tree alone rather than throwing.
 */
function renumberPageLabels(doc: PDFDocument, order: number[]): void {
  try {
    const root = doc.catalog.lookupMaybe(PDFName.of('PageLabels'), PDFDict);
    if (!root) return;

    const entries = readNumberTree(doc, root);
    if (entries.length === 0) return;

    const nums = doc.context.obj([]) as PDFArray;
    let previous: PDFObject | undefined;
    for (let newIndex = 0; newIndex < order.length; newIndex += 1) {
      const resolved = labelFor(entries, order[newIndex]);
      // Only emit an entry where the applicable label actually changes from
      // the page before it: a number tree's key marks where a run *starts*,
      // so re-emitting an unchanged one at every index would still be read
      // correctly but every key in between would too, which defeats
      // rebuilding this as a flat tree in the first place.
      if (resolved !== undefined && resolved !== previous) {
        nums.push(doc.context.obj(newIndex));
        nums.push(resolved);
      }
      previous = resolved;
    }

    root.delete(PDFName.of('Kids'));
    root.delete(PDFName.of('Limits'));
    root.set(PDFName.of('Nums'), nums);
  } catch {
    // Best-effort: a page-labels tree too malformed to read leaves the
    // document exactly as unrenumbered as it was before this ran.
  }
}

/** The label in effect for `oldIndex`, per number-tree "nearest key below" rules. */
function labelFor(entries: Array<[number, PDFObject]>, oldIndex: number): PDFObject | undefined {
  let result: PDFObject | undefined;
  for (const [key, value] of entries) {
    if (key > oldIndex) break;
    result = value;
  }
  return result;
}

/**
 * Every entry of a number tree, resolving `/Kids` regardless of how many
 * levels the writer sharded it across, sorted by key.
 */
function readNumberTree(doc: PDFDocument, root: PDFDict): Array<[number, PDFObject]> {
  const entries: Array<[number, PDFObject]> = [];
  const seen = new Set<PDFDict>();
  const stack: PDFDict[] = [root];

  while (stack.length > 0) {
    const node = stack.pop() as PDFDict;
    // Guards against a malformed tree whose /Kids cycle back on themselves.
    if (seen.has(node)) continue;
    seen.add(node);

    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) {
      for (const kid of kids.asArray()) {
        const kidDict = doc.context.lookupMaybe(kid, PDFDict);
        if (kidDict) stack.push(kidDict);
      }
      continue;
    }

    const nums = node.lookupMaybe(PDFName.of('Nums'), PDFArray);
    if (!nums) continue;
    for (let index = 0; index + 1 < nums.size(); index += 2) {
      const key = nums.get(index);
      if (key instanceof PDFNumber) entries.push([key.asNumber(), nums.get(index + 1)]);
    }
  }

  return entries.sort(([a], [b]) => a - b);
}

function buildPageMap(order: number[]): Map<number, number> {
  const pageMap = new Map<number, number>();
  order.forEach((sourceIndex, position) => pageMap.set(sourceIndex + 1, position + 1));
  return pageMap;
}
