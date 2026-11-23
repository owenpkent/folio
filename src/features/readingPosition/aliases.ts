/**
 * Secondary identities for a document, so its position survives the file
 * being re-saved by another program (new content hash, same trailer /ID) or
 * moved (new /ID, same path).
 *
 * Both are SHA-256 digests with a prefix, never the plaintext: the position
 * list must not hold a path or anything a path could be read back from. The
 * prefixes keep an id and a path that happen to be the same string from
 * colliding.
 */

export interface PositionKeys {
  /** The content key: SHA-256 of the bytes as opened. */
  fingerprint: string;
  /** Digest of the engine's fingerprint (the trailer /ID, see loadSourceHoldingLock). */
  idKey: string | null;
  /** Digest of the normalised path, when the document came from one. */
  pathKey: string | null;
}

async function digest(text: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Backslashes become slashes, so one file reached two ways matches; a Windows
 * drive path is also lowercased, because that filesystem ignores case. A POSIX
 * path keeps its case: there `A.pdf` and `a.pdf` are different files.
 */
export function normalisePath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
}

export const idAlias = (legacyKey: string): Promise<string | null> => digest(`id:${legacyKey}`);

export const pathAlias = (path: string): Promise<string | null> =>
  digest(`path:${normalisePath(path)}`);

/** All the keys a document is filed and looked up under. */
export async function positionKeys(
  fingerprint: string,
  legacyKey: string | null,
  path: string | null,
): Promise<PositionKeys> {
  return {
    fingerprint,
    idKey: legacyKey ? await idAlias(legacyKey) : null,
    pathKey: path ? await pathAlias(path) : null,
  };
}
