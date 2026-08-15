# Page operations

Deleting, reordering, and rotating the pages of a document. Merging whole PDFs
into one is covered by [Combine](#combining-whole-pdfs) below; inserting and
splitting are still on the [roadmap](../ROADMAP.md).

## Where they live

Two surfaces, one implementation. Both render the same `PageList`
(`src/features/pageops/PageList.tsx`), so selection, dragging, and every
keyboard path behave identically in each.

- **The thumbnails sidebar** (the Pages tab), for a quick change while reading.
- **Pages → Organize pages**, a full-window grid, for restructuring a long
  document. One column of small thumbnails is a poor place to move page 4 to
  page 90.

## Combining whole PDFs

**Combine PDFs…** sits at the top of the Pages tab, above the thumbnails, and
opens the same dialog File → Combine PDFs… does. Combining is a page-level
operation, so it belongs with the pages rather than only in a menu.

Two placement decisions are worth knowing, because both are load-bearing:

- **Outside the scrolling list**, in a row of its own. The same reasoning that
  moved the selection action bar out of the scroll box applies: a control
  floating over the thumbnails is a control that can swallow a click meant for a
  page's selection checkbox, since whichever element paints on top also receives
  the click.
- **Not gated on a document being open.** The dialog takes its inputs from a
  file picker, so building a new PDF out of several files is the one thing on
  this tab worth reaching from an empty viewer. With no document open the tab
  shows the button above "No document open."

The merge itself is unchanged and documented with the feature; see the
[CHANGELOG](../CHANGELOG.md) entry for what it carries across from each input.

## Picking pages out

Each page carries a checkbox, shown on hover, on focus, or once the page is
selected. It stays in the tab order and in the accessibility tree at all times;
fading it is a visual choice, not a gate.

| Gesture | Effect |
| --- | --- |
| Click the page | Go to it (unchanged) |
| Click its checkbox | Add or remove it from the selection |
| Shift-click | Extend the selection from the anchor |
| Ctrl/Cmd-click the page | Add or remove it, instead of navigating |
| `Space` on a page | Add or remove it, the way a file list behaves |
| `Enter` on a page | Go to it |
| `Ctrl/Cmd+A` | Select every page (only while the organizer is open, so it does not shadow "select the text on this page") |

## Acting on them

| Action | Keyboard | Also |
| --- | --- | --- |
| Move up / down | `Alt+↑` / `Alt+↓` | Drag; the selection bar; the Pages menu |
| Rotate left / right | `Ctrl/Cmd+[` / `Ctrl/Cmd+]` | The selection bar; the Pages menu |
| Delete | `Delete` or `Backspace` on a focused page | The selection bar; the Pages menu |
| Undo | `Ctrl/Cmd+Z` | The Pages menu |

Dragging is bound to mouse and pen only. In the sidebar a vertical touch-drag is
how the panel scrolls, and taking that over would trade a common gesture for a
rare one; touch reorders with the selection bar's move buttons.

A selection that is not contiguous gathers into one block when it moves, which
is what dragging it would do anyway.

## How a change is applied

Every gesture is turned into a **page plan**: the whole end state, as a list of
source page indices in their new order plus any turns
(`src/features/pageops/types.ts`). Declaring the result rather than a sequence of
moves is what lets a drag across ninety positions, or a delete of a scattered
selection, commit as one mutation and one undo step.

Committing follows the same serialize / mutate / live-reload pipeline the text
and image editors use: read the current bytes out of the engine, apply the plan
with `pdf-lib`, hand the result back to PDF.js.

Reordering happens **inside the existing document** rather than by copying pages
into a fresh one. `PDFDocument.copyPages` drops catalog-level data — the outline,
the AcroForm, document metadata — and losing a document's bookmarks because
someone moved page 4 above page 3 is not a trade worth making.

Undo restores the document's bytes *and* everything placed on its pages, because
deleting a page also deletes the highlights and signatures that were on it.

A page operation holds the [document mutation
lock](architecture.md#the-document-mutation-lock) for its whole commit, at the
widest scope there is: renumbering the pages moves the page map every sidecar
store is keyed to, so nothing else that touches the document may interleave with
it — not another page operation, not a text or image edit, not a save, print,
sign, combine, OCR pass, open, or close. Each of those disables itself with an
explanatory tooltip while the commit runs, and refuses with a toast if reached by
a keybinding anyway. The buttons in this feature's own action bar disable on its
own `busy` flag instead, so they never blame "another document change" for the
operation the user just started here.

## Deleting removes the content

`pdf-lib`'s `removePage` only unlinks a page from the page tree. Its writer then
serialises every object still registered, reachable or not, so the deleted page's
content stream, images, and annotations stay in the saved file, recoverable by
anyone willing to run a parser over the bytes. For a command a user reads as
"delete this page", that is a trap.

Deleting therefore runs a mark-and-sweep (`src/features/pageops/gc.ts`):

1. **Mark.** Walk out from the trailer, refusing to step through a dropped
   page's reference, so nothing that page alone owned is ever marked live.
2. **Scrub.** Remove the now-dangling references from whatever survived. This is
   deliberately generic rather than a list of special cases, so bookmark
   destinations, named destinations, `/OpenAction`, link targets, page labels,
   and structure-tree page pointers are all handled by construction. A bookmark
   whose page is gone keeps its title and loses its destination, rather than
   disappearing or pointing at nothing.
3. **Sweep.** Unregister everything left unmarked.

The sweep is told about more than the pages. Several standard structures reach a
page's content by a path that never touches the page object, so each of those is
added to the set the mark phase refuses to walk through:

- **The page's annotations.** `/AcroForm /Fields` reaches a widget directly, and
  in a tagged document so does `/StructTreeRoot` → `/K` → `/OBJR` → `/Obj`.
  Without this a deleted page's filled field values and the appearance streams
  that render them stay in the file on the form's or the structure tree's
  account. Form fields whose every widget is gone are pruned from `/Fields` as
  well, so the document does not carry a field with no page to render it on.
- **Structure elements that describe only that page.** A leaf `/StructElem`
  holds the `/Alt` and `/ActualText` for the content it tags; scrubbing its
  `/Pg` would leave that text behind describing a page nobody can see. Container
  elements are kept, because their children may sit on pages that are staying.

### What the sweep does not reach

An object is only collected if nothing still standing can reach it. A resource
shared by inheritance is still reachable, so an image that only the deleted page
drew, but which the producer put in a `/Resources` dictionary on the page *tree*
node rather than on the page itself, stays in the file.

Closing that would mean parsing every surviving page's content streams to work
out which resources are still named, and a mistake there deletes something a
remaining page draws. Since **Save** writes over the user's own file, the cost of
being wrong in that direction is much higher than the cost of an unused image
lingering, so the sweep stays conservative. Most producers write `/Resources` on
the page leaf, where deleting the page takes the resources with it.

A document must keep at least one page, so deleting the last one is refused.

## The result is read back before it is used

Page operations are the only thing in the app that *deletes* indirect objects,
and **Save** writes their output straight over the file the document was opened
from. A bug in the sweep would therefore destroy the original, and the export
path's existing `isPlausiblePdf` check only looks for a `%PDF-` header, which a
document with a shredded object graph still has.

So `verifyResult` in `mutate.ts` parses the rewritten bytes once and checks the
page count before they leave the module. A plan whose result cannot be read back
fails with `unreadable-result`, the announcement says so, and nothing is handed
to the engine: the open document is left exactly as it was. It costs one pass
over bytes that were just serialised, which is cheap next to losing a file.

## Rotation and what is placed on a page

Overlays — placed text, images, check marks, signatures, highlights, sticky
notes, the OCR layer — store their position as a fraction of the page **as
displayed**, which is the box they were dragged around inside. PDF.js sizes that
box from a viewport that has already applied `/Rotate`, so a page turned 90°
shows a box with its sides swapped relative to its MediaBox.

`src/core/pdf/pageGeometry.ts` is the single mapping between that space and the
PDF user space `pdf-lib` draws into, and every stamper goes through it:

- `placeRect` for anything that draws content (an image, a text baseline, a
  glyph), which also has to be counter-rotated so it reads upright.
- `boxRect` for anything positioned by extent (an annotation `/Rect`, a
  highlight's `/QuadPoints`), which the reader turns along with the page.

Turning a page also carries its overlays round with it, so a highlight stays over
the words it marked.

### Limitations

- An overlay's position follows the page through a turn, but the overlay itself
  is still drawn upright in its new box. For a highlight, a check mark, or the
  OCR layer that is exactly right; a signature or a placed image on a page that
  is then rotated ends up in the right place but not turned, and in a box whose
  proportions have swapped. Fixing that needs a per-item orientation the sidecar
  format does not carry yet.
- The mapping measures against the MediaBox. A document whose CropBox differs
  from its MediaBox is offset by that difference, which is a separate,
  pre-existing gap.
- Page operations rewrite the page tree, which invalidates any cryptographic
  signature over the old bytes. Folio says so once per document, at the first
  operation.

## Tests

- `src/features/pageops/mutate.test.ts` — reorder, delete, rotate, and the
  guarantee that a deleted page's text is not in the saved bytes, against real
  documents with an outline and an AcroForm.
- `src/features/pageops/plans.test.ts` and `dropTarget.test.ts` — the index
  arithmetic behind a drag.
- `src/core/pdf/pageGeometry.test.ts` — the rotation mapping, at all four turns.
- `src/features/pageops/pageState.test.ts` — page-keyed state surviving a plan.
- `src/features/pageops/PageList.test.tsx` — selection and keyboard operation.
- `e2e/pages.spec.ts` — delete, undo, drag, keyboard reorder, rotate, and the
  organizer, in a real browser.
