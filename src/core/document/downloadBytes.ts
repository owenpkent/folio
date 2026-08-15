/**
 * Save bytes to the user's downloads via a same-origin blob URL.
 *
 * Its own module rather than living on `saveDocument.ts` (Save a copy's
 * browser path) or `openFromQuery.ts` (Download original), which both use it:
 * `saveDocument.ts` imports `@/commands`, whose barrel re-exports
 * `defaultCommands.ts`, which imports `originalDocumentUrl`/`downloadOriginal`
 * from `openFromQuery.ts` -- reusing `saveDocument.ts`'s copy from there would
 * make the two modules import each other by way of three others. A
 * dependency-free leaf avoids that entirely.
 */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  // Copy into a fresh ArrayBuffer-backed view so the type is a valid BlobPart.
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
