/**
 * Hit-testing the AcroForm widget layer beneath a full-page click-catcher.
 *
 * PDF.js's own forms layer (`.folio-forms-layer`, z-index 3; see
 * src/styles/global.css) only takes pointer events over each field's own
 * small rect, so the rest of a page falls through to whatever sits under it.
 * Several tools cover the whole page with an opaque click-catcher at a higher
 * z-index while armed (in-place text editing, check-mark placement, image
 * selection), so without checking here first, any of them would swallow a
 * click meant for a checkbox or field instead of the field ever seeing it.
 * What to do once a widget is found differs per tool (see the call sites in
 * TextEditLayer.tsx, EditLayer.tsx, and ImageEditLayer.tsx for each one's
 * reasoning), but the hit-test itself is identical, so it lives here once
 * rather than three times.
 */

/**
 * The interactive AcroForm widget at (clientX, clientY), if any: the topmost
 * element there that is both inside `.folio-forms-layer` and one of the form
 * control types PDF.js's annotation layer renders. `elementsFromPoint`
 * returns every element stacked at that point, front (topmost) to back, so
 * the first match found while walking it is the one the user would actually
 * see and expect to hit.
 */
export function formWidgetAt(clientX: number, clientY: number): HTMLElement | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!el.closest('.folio-forms-layer')) continue;
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      return el;
    }
  }
  return null;
}
