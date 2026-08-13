/**
 * Mark-and-sweep for pages a plan dropped.
 *
 * pdf-lib's writer serialises every indirect object still registered on the
 * context, whether or not anything can reach it. Unlinking a page from the page
 * tree — which is all `PDFDocument.removePage` does — therefore leaves the
 * page's content stream, its images, and its annotations sitting in the saved
 * file, recoverable by anyone willing to run a parser over the bytes. For a
 * command the user reads as "delete this page" that is a privacy trap, so
 * dropping a page runs the sweep below before saving.
 *
 * The sweep is deliberately generic. Rather than hunting down each structure
 * that can name a page (outlines, named destinations, `/OpenAction`, link
 * annotations, the structure tree, page labels), phase one simply refuses to
 * step through a dropped page's ref, so nothing only that page owned is ever
 * marked live; phase two then scrubs the now-dangling refs out of whatever
 * survived. Anything that names a page is handled by construction.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';

export interface SweepResult {
  /** Indirect objects unregistered from the context. */
  deleted: number;
  /** References to dropped pages removed from objects that survived. */
  scrubbed: number;
}

/**
 * Remove every indirect object that only the dropped pages could reach, and
 * scrub references to those pages out of everything left standing.
 *
 * Objects that were already unreachable before the plan ran go too; that is a
 * side effect rather than the point, and it is why callers only run this when a
 * plan actually dropped a page.
 */
export function sweepDroppedPages(
  context: PDFContext,
  droppedPages: Iterable<PDFRef>,
): SweepResult {
  const dropped = new Set<PDFRef>(droppedPages);
  const live = mark(context, dropped);

  let scrubbed = 0;
  for (const ref of live) {
    const object = context.lookup(ref);
    if (object) scrubbed += scrub(object, dropped);
  }

  let deleted = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (live.has(ref)) continue;
    context.delete(ref);
    deleted += 1;
  }

  return { deleted, scrubbed };
}

/**
 * Every ref reachable from the trailer without passing through a dropped page.
 *
 * `PDFRef` interns its instances, so a `Set<PDFRef>` compares by identity and
 * by object number at the same time.
 */
function mark(context: PDFContext, dropped: Set<PDFRef>): Set<PDFRef> {
  const live = new Set<PDFRef>();
  const queue: PDFObject[] = [];

  const { Root, Info, Encrypt, ID } = context.trailerInfo;
  for (const root of [Root, Info, Encrypt, ID]) {
    if (root) queue.push(root);
  }

  // An explicit worklist rather than recursion: page trees and structure trees
  // in a large document nest deeply enough to matter.
  while (queue.length > 0) {
    const object = queue.pop() as PDFObject;

    if (object instanceof PDFRef) {
      if (dropped.has(object) || live.has(object)) continue;
      live.add(object);
      const target = context.lookup(object);
      if (target) queue.push(target);
      continue;
    }

    if (object instanceof PDFArray) {
      for (const item of object.asArray()) queue.push(item);
      continue;
    }

    const dict = asDict(object);
    if (dict) {
      for (const value of dict.values()) queue.push(value);
    }
  }

  return live;
}

/**
 * Drop references to dropped pages from one surviving object and the direct
 * (non-indirect) containers nested inside it. Indirect children are reached
 * through the live set instead, so this never follows a ref.
 */
function scrub(object: PDFObject, dropped: Set<PDFRef>): number {
  let scrubbed = 0;
  const stack: PDFObject[] = [object];

  while (stack.length > 0) {
    const node = stack.pop() as PDFObject;

    if (node instanceof PDFArray) {
      // Backwards: removing an element shifts everything after it down.
      for (let i = node.size() - 1; i >= 0; i -= 1) {
        const item = node.get(i);
        if (item instanceof PDFRef) {
          if (dropped.has(item)) {
            node.remove(i);
            scrubbed += 1;
          }
          continue;
        }
        if (isContainer(item)) stack.push(item);
      }
      continue;
    }

    const dict = asDict(node);
    if (!dict) continue;

    for (const [key, value] of dict.entries()) {
      if (value instanceof PDFRef) {
        if (dropped.has(value)) {
          dict.delete(key);
          scrubbed += 1;
        }
        continue;
      }
      // A destination whose page is gone means nothing, and leaving the array
      // behind minus its first element would read as a destination to page 0.
      if (value instanceof PDFArray && isDeadDestination(value, dropped)) {
        dict.delete(key);
        scrubbed += 1;
        continue;
      }
      if (isContainer(value)) stack.push(value);
    }
  }

  return scrubbed;
}

/**
 * Whether an array is a destination (`[page /Fit]`, `[page /XYZ l t z]`, …)
 * aimed at a dropped page.
 *
 * The name in the second slot is what separates a destination from a `/Kids`
 * array, which also holds page refs and must not be deleted wholesale.
 */
function isDeadDestination(array: PDFArray, dropped: Set<PDFRef>): boolean {
  if (array.size() < 2) return false;
  const target = array.get(0);
  if (!(target instanceof PDFRef) || !dropped.has(target)) return false;
  return array.get(1) instanceof PDFName;
}

function isContainer(object: PDFObject): boolean {
  return object instanceof PDFArray || object instanceof PDFDict || object instanceof PDFStream;
}

function asDict(object: PDFObject): PDFDict | null {
  if (object instanceof PDFStream) return object.dict;
  if (object instanceof PDFDict) return object;
  return null;
}
