import { getViewerElement } from '@/state/viewerElement';

/**
 * A "skip to document" link: the first focusable element on the page, visually
 * hidden until focused. Lets keyboard and screen-reader users jump past the
 * toolbar straight to the content.
 */
export function SkipLink() {
  return (
    <a
      className="folio-skip-link"
      href="#folio-main"
      onClick={(e) => {
        // Land focus on the scroller itself, not its <main> wrapper: the
        // browser scrolls the focused element's nearest scrollable *ancestor*,
        // and <main> is a non-scrolling parent of the viewer, so skipping to it
        // would leave Page Up / arrows with nothing to act on. With no document
        // open there is no viewer, so the plain anchor jump to <main> stands.
        const viewer = getViewerElement();
        if (!viewer) return;
        e.preventDefault();
        viewer.focus();
      }}
    >
      Skip to document
    </a>
  );
}
