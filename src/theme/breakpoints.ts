/**
 * Width breakpoints for the narrow-viewport ("mobile") layout. CSS media
 * queries cannot read custom properties, so the same values are hardcoded in
 * the mobile section of src/styles/global.css — keep the two in sync.
 *
 * ≤640px (narrow): the sidebar overlays the viewer as a drawer and the
 * toolbar folds its pinned tail + secondary zoom tools into the More menu.
 * ≤480px (compact): zoom in/out and the % readout fold as well.
 */
export const NARROW_VIEWPORT_QUERY = '(max-width: 640px)';
export const COMPACT_VIEWPORT_QUERY = '(max-width: 480px)';

/** True when the window is phone-narrow right now. Safe where matchMedia is
 *  unavailable (jsdom): reports false, i.e. the desktop layout. */
export const isNarrowViewport = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
