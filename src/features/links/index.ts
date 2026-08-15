// Trimmed to what the rest of the app actually reaches for: PdfViewer mounts
// the hint and drives the hover tracker, and the context-menu store types its
// resolved target. Everything else here (detect.ts, resolve.ts, the hover
// store) is this feature's own internals -- its unit tests import those
// modules directly rather than through this barrel, which is what keeps this
// list honest.
export { AddressHint } from './AddressHint';
export { useTrackAddressHover } from './useTrackAddressHover';
export { copyTargetAt } from './copyTarget';
export type { CopyTarget } from './resolve';
