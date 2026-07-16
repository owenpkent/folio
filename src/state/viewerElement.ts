/**
 * A handle on the scrollable viewer element.
 *
 * The document surface is scrolled by commands (Page Up / Page Down / Space)
 * and focused when a document opens, both of which happen outside React's tree.
 * This is deliberately a plain module rather than store state: the element is
 * an imperative handle, and putting it in the store would re-render every
 * subscriber when it mounts.
 */
let element: HTMLElement | null = null;

export function setViewerElement(el: HTMLElement | null): void {
  element = el;
}

export function getViewerElement(): HTMLElement | null {
  return element;
}

/**
 * Give the viewer keyboard focus, so the browser's own scroll keys (arrows,
 * Space, Home/End) act on it. `preventScroll` because focusing must not itself
 * move the reading position.
 */
export function focusViewer(): void {
  element?.focus({ preventScroll: true });
}

/**
 * Scroll the viewer by a fraction of its height. A little under a full screen
 * so a line or two carries over between presses and the reader keeps their
 * place. Returns false when there is no viewer to scroll.
 */
export function scrollViewerByPage(direction: 1 | -1): boolean {
  if (!element) return false;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  element.scrollBy({
    top: direction * element.clientHeight * 0.9,
    behavior: reduced ? 'auto' : 'smooth',
  });
  return true;
}
