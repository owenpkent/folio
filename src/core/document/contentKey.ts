import type { DocumentSource } from '@/core/pdf';

/**
 * The identity Folio files a document's sidecar state under: a SHA-256 of
 * the bytes exactly as opened, hex-encoded.
 *
 * Why not the engine's own fingerprint: PDF.js derives it from the first half
 * of the trailer /ID, or from an MD5 of the first 1 KB when there is no valid
 * ID. Both are properties of the *template*, not the file: every form filled
 * from the same blank carries the same /ID, and every file with the same
 * header the same first kilobyte. Keying signatures, edits, annotations and
 * OCR text on that put one person's signature on another person's copy of the
 * same form. A hash of the whole file cannot be shared by two different files.
 *
 * The cost is the mirror image: a file re-saved by another program (so the
 * same /ID but different bytes) no longer finds the sidecar Folio kept for it.
 * Losing unsaved placements to a foreign re-save is the safer failure.
 *
 * This is the key for the bytes *as opened*. In-place text and image edits
 * and page operations swap the engine's bytes without changing it (see
 * reloadEditedBytes), so state placed on a page survives the page being
 * renumbered. Rehashing on every reload would orphan it instead.
 *
 * Returns null when there are no bytes to hash (a url source, which nothing
 * produces today) or hashing itself fails; the caller then falls back to the
 * engine's fingerprint rather than refusing to open the file.
 */
export async function contentKey(source: DocumentSource): Promise<string | null> {
  if (source.kind !== 'bytes') return null;
  try {
    // Must run before the engine takes the bytes: PDF.js transfers the array
    // to its worker and detaches this view, so there is nothing left to hash
    // afterwards. loadSourceHoldingLock orders the calls accordingly.
    const { data } = source;
    const digest = await crypto.subtle.digest(
      'SHA-256',
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    );
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
