/**
 * Screen-reader announcements via ARIA live regions.
 *
 * Two hidden regions are created lazily on <body>: a polite one for routine
 * updates (page changes, zoom) and an assertive one for errors. Callers just
 * use {@link announce}; the DOM plumbing is handled here.
 */

let politeRegion: HTMLElement | null = null;
let assertiveRegion: HTMLElement | null = null;

function createRegion(kind: 'polite' | 'assertive'): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('role', kind === 'assertive' ? 'alert' : 'status');
  el.setAttribute('aria-live', kind);
  el.setAttribute('aria-atomic', 'true');
  el.className = 'folio-sr-only';
  document.body.appendChild(el);
  return el;
}

/**
 * Announce a message to assistive technology. Pass `assertive` for errors that
 * should interrupt; otherwise updates are queued politely.
 */
export function announce(message: string, assertive = false): void {
  if (typeof document === 'undefined') return;

  const region = assertive
    ? (assertiveRegion ??= createRegion('assertive'))
    : (politeRegion ??= createRegion('polite'));

  // Clear first so an identical consecutive message is still re-announced.
  region.textContent = '';
  window.requestAnimationFrame(() => {
    region.textContent = message;
  });
}
