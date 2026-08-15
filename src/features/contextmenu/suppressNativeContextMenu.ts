import { isTauri } from '@/core/document/openDocument';

/**
 * Where the webview's own context menu is left alone.
 *
 * A text field's native menu is cut / copy / paste, which Folio offers nowhere
 * else, and that includes the form-field widgets rendered over a page. Anything
 * else that wants the same treatment opts in with `data-context-native`.
 *
 * Shared with the viewer's own handler (see PdfViewer's `onContextMenu`) so the
 * two cannot drift: a field that keeps the native menu over the document must
 * keep it in the sidebar too.
 */
export const NATIVE_CONTEXT_MENU_TARGETS =
  'input, textarea, [contenteditable="true"], [data-context-native]';

/**
 * Stop the webview from answering a right-click with a browser menu, and return
 * a function that stops doing so.
 *
 * The document itself already replaces that menu with Folio's own, but the
 * document is all it covers: right-clicking the sidebar, the toolbar, the
 * splash screen, or a dialog produced WebView2's menu instead -- Back, Reload,
 * Save as, Print, Inspect -- which offers navigation a PDF viewer does not
 * have, actions that duplicate Folio's own with different behavior (Print,
 * Save as), and a route into the page's markup. None of that is part of the
 * application; it is the frame the application happens to be running in
 * showing through, and a reader has no reason to expect a document window to
 * behave like a browser tab.
 *
 * Desktop only, and deliberately so: in the browser build this really is a page
 * in a tab, and taking away the browser's own menu on everything but the
 * document would break the conventions of the surface it is running on.
 *
 * Suppression, not replacement. A native application's chrome mostly has no
 * context menu at all, and inventing one for the sidebar and toolbar would be
 * new surface to design, translate, and keep reachable from the keyboard. The
 * document keeps the menu that earns its place.
 */
export function suppressNativeContextMenu(): () => void {
  if (!isTauri()) return () => {};

  const onContextMenu = (event: MouseEvent) => {
    // Folio's own menu got there first: PdfViewer prevents the default before
    // opening it, so there is nothing left to suppress and no reason to look.
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof Element && target.closest(NATIVE_CONTEXT_MENU_TARGETS)) return;
    event.preventDefault();
  };

  // Bubble phase on purpose: React's handlers run at the root container, which
  // is below this, so the viewer's menu has already claimed the event by the
  // time this sees it.
  document.addEventListener('contextmenu', onContextMenu);
  return () => document.removeEventListener('contextmenu', onContextMenu);
}
