import forge from 'node-forge';

/**
 * Best-effort information about a digital signature found in a PDF.
 *
 * `coversWholeDocument` is a reliable integrity signal: it is false when content
 * was appended after signing (a later revision or tampering). Full CMS digest
 * verification and certificate-chain trust validation are not yet performed;
 * see docs/forms-and-signatures.md.
 */
export interface DetectedSignature {
  signerName: string | null;
  signingTime: string | null;
  coversWholeDocument: boolean;
}

/**
 * Latin-1 decode of a byte range.
 *
 * Deliberately never called on the whole file. Decoding an entire PDF produced a
 * JS string with one character per byte, which the first regex then flattened
 * into a second full-size contiguous allocation. On a few-hundred-MB document
 * that is enough to take the renderer process down (and past V8's ~512MB string
 * limit it throws outright). Every caller below bounds its window instead.
 */
function latin1(bytes: Uint8Array, start: number, end: number): string {
  const from = Math.max(0, Math.min(start, bytes.length));
  const to = Math.max(from, Math.min(end, bytes.length));
  // Chunked to avoid call-stack limits on the larger windows.
  let out = '';
  const chunk = 0x8000;
  for (let i = from; i < to; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, to)));
  }
  return out;
}

/** Byte-level indexOf for an ASCII needle, so scanning costs no allocation. */
function indexOfAscii(bytes: Uint8Array, needle: string, from: number): number {
  const first = needle.charCodeAt(0);
  const last = bytes.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * The bytes `/\s/` matched back when this scanner tested a latin1 string: TAB,
 * LF, VT, FF, CR, SPACE and NBSP. Notably NOT NUL, which PDF counts as
 * whitespace but `/\s/` does not. Kept as-is so the verdict does not change.
 */
function isSpaceByte(b: number): boolean {
  return b === 9 || b === 10 || b === 11 || b === 12 || b === 13 || b === 32 || b === 160;
}

/** True when nothing but whitespace follows `from`, i.e. the signature covers
 * the whole file. Scans the bytes directly rather than copying the tail. */
function onlySpaceAfter(bytes: Uint8Array, from: number): boolean {
  for (let i = Math.max(0, from); i < bytes.length; i++) {
    if (!isSpaceByte(bytes[i])) return false;
  }
  return true;
}

function signerFromContents(hex: string): string | null {
  try {
    // node-forge 1.4 accepts an options object here (to tolerate the zero-padded
    // signature placeholder); the bundled type definitions are outdated.
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(forge.util.hexToBytes(hex)), {
      parseAllBytes: false,
    } as unknown as boolean);
    const message = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData;
    const cert = message.certificates?.[0];
    return (cert?.subject.getField('CN')?.value as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Pull the /M (signing time) entry out of an already-bounded window. */
function signingTimeNear(window: string): string | null {
  const m = window.match(/\/M\s*\(D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/** Enough to cover `/ByteRange [ a b c d ]` however loosely it is spaced. */
const BYTE_RANGE_WINDOW = 200;
/**
 * Ceiling on the gap between the two signed ranges (i.e. the Contents hex). A
 * PKCS#7 blob runs to tens of KB; 4MB is far past any real one and stops a
 * corrupt or hostile /ByteRange from naming a window the size of the file.
 */
const MAX_GAP = 4 * 1024 * 1024;

/** Most results to return. A document with more signatures than this is not
 *  something the panel can usefully show anyway. */
const MAX_RESULTS = 50;

/**
 * Most candidate `/ByteRange` sites to examine, matched or not.
 *
 * {@link MAX_RESULTS} bounds successful *matches*, which is no bound at all on a
 * file that repeats the literal `/ByteRange` without a valid array after it:
 * every occurrence still costs a window decode and a regex. A megabyte of them
 * measured ~290ms of pure scanning, on the main thread, at open. The cost of the
 * cap is that a signature hidden behind 200 decoy sites goes unreported, which
 * is the right way round: detection here is advisory (see the note on
 * {@link DetectedSignature}), so failing to report is safe and burning the main
 * thread is not.
 */
const MAX_SITES = 200;

/**
 * Total bytes {@link latin1} may be asked to decode across one scan.
 *
 * MAX_GAP bounds each window but not their product with MAX_RESULTS: 50
 * signature dictionaries each naming a 4MB gap is ~400MB of transient UTF-16,
 * which is the kind of allocation this rewrite exists to avoid.
 */
const MAX_WINDOW_BUDGET = 16 * 1024 * 1024;

/** Detect digital signatures in a PDF and extract basic, verifiable info. */
export function detectSignatures(bytes: Uint8Array): DetectedSignature[] {
  const byteRange = /^\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/;
  const results: DetectedSignature[] = [];
  let sites = 0;
  let budget = MAX_WINDOW_BUDGET;

  let at = indexOfAscii(bytes, '/ByteRange', 0);
  while (at !== -1 && results.length < MAX_RESULTS && sites < MAX_SITES && budget > 0) {
    sites += 1;
    const match = byteRange.exec(latin1(bytes, at, at + BYTE_RANGE_WINDOW));
    if (match) {
      const a = +match[1];
      const b = +match[2];
      const c = +match[3];
      const d = +match[4];

      // The signature Contents hex sits in the gap between the two signed ranges.
      const gapStart = a + b;
      const gapEnd = Math.min(c, gapStart + MAX_GAP);
      const timeEnd = Math.min(c + 500, at + MAX_GAP);
      budget -= Math.max(0, gapEnd - gapStart) + Math.max(0, timeEnd - (at - 1000));
      const hex = latin1(bytes, gapStart, gapEnd).match(/<([0-9A-Fa-f]+)/)?.[1] ?? '';

      results.push({
        signerName: hex ? signerFromContents(hex) : null,
        // The window the /M entry is looked for in: from just before the
        // signature dictionary to just past its Contents.
        signingTime: signingTimeNear(latin1(bytes, at - 1000, timeEnd)),
        // `c` and `d` come straight out of the file. A range ending past EOF
        // describes bytes that do not exist, and the scan below would find
        // nothing to object to and return true vacuously -- which the panel
        // renders as a green "no changes after signing" badge. So a hostile
        // `/ByteRange [0 1 999999999 1]` plus appended content earned a clean
        // bill of health. Out of range is not a pass.
        coversWholeDocument: c + d <= bytes.length && onlySpaceAfter(bytes, c + d),
      });
    }
    // `/ByteRange` has no proper border, so an occurrence can never overlap
    // another: the next one cannot start inside this one.
    at = indexOfAscii(bytes, '/ByteRange', at + '/ByteRange'.length);
  }

  return results;
}
