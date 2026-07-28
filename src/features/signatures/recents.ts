import { SIGNATURE_FONTS } from './types';

/**
 * Names the user has signed with before, most recent first, kept globally (not
 * per document) so signing a new PDF does not mean typing your name again.
 * Only the text and the chosen font are stored, never the rendered image.
 */

const STORAGE_KEY = 'folio.signatures.recentNames';
const MAX_RECENTS = 5;
/** Long enough for any real name; a guard against a pasted wall of text. */
const MAX_NAME_LENGTH = 120;

export interface RecentSignatureName {
  name: string;
  /** CSS font stack, one of SIGNATURE_FONTS. */
  font: string;
}

const KNOWN_FONTS = new Set(SIGNATURE_FONTS.map((f) => f.value));

/** Keep only well-formed entries: localStorage is user-writable, so validate. */
function sanitize(raw: unknown): RecentSignatureName[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentSignatureName[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, font } = entry as Partial<RecentSignatureName>;
    if (typeof name !== 'string' || typeof font !== 'string') continue;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > MAX_NAME_LENGTH) continue;
    // An unknown font stack would be interpolated into a canvas font string
    // and a style attribute; fall back rather than trust it.
    out.push({ name: trimmed, font: KNOWN_FONTS.has(font) ? font : SIGNATURE_FONTS[0].value });
    if (out.length === MAX_RECENTS) break;
  }
  return out;
}

/** The remembered names, most recent first. */
export function getRecentSignatureNames(): RecentSignatureName[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/**
 * Record a name as just used and return the new list. Re-using a name moves it
 * to the front (matched case-insensitively) rather than duplicating it.
 */
export function rememberSignatureName(name: string, font: string): RecentSignatureName[] {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return getRecentSignatureNames();

  const entry: RecentSignatureName = {
    name: trimmed,
    font: KNOWN_FONTS.has(font) ? font : SIGNATURE_FONTS[0].value,
  };
  const key = trimmed.toLowerCase();
  const next = [entry, ...getRecentSignatureNames().filter((r) => r.name.toLowerCase() !== key)] //
    .slice(0, MAX_RECENTS);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable; the list is still correct for this session */
  }
  return next;
}
