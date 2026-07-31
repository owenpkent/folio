import { describe, expect, it } from 'vitest';

import { detectSignatures } from './verify';

/**
 * A fixed-width /ByteRange, so the real offsets can be patched in after the
 * layout is final without shifting anything. Real signers pad it for the same
 * reason: the numbers cannot be known until the bytes they describe are placed.
 */
const RANGE_PLACEHOLDER = '[0000000000 0000000000 0000000000 0000000000]';

const pad10 = (n: number) => String(n).padStart(10, '0');

interface SigSpec {
  time: string;
  hex?: string;
}

/**
 * Build a PDF-shaped buffer holding `signatures` signature dictionaries with
 * genuine absolute /ByteRange offsets.
 *
 * `/ByteRange [a b c d]` signs bytes [a, a+b) and [c, c+d); the gap between them
 * holds the Contents hex. Anything after c+d was appended after signing, which
 * is what `coversWholeDocument` reports on, so `trailing` lands there.
 *
 * Sections are separated by `gap` bytes of filler because the scanner looks for
 * the /M entry in a window starting 1000 bytes before each /ByteRange; without
 * the separation a later signature would find an earlier one's timestamp.
 */
function buildPdf({
  signatures,
  leading = '',
  trailing = '',
  gap = 2000,
}: {
  signatures: SigSpec[];
  leading?: string;
  trailing?: string;
  gap?: number;
}): Uint8Array {
  const filler = ' '.repeat(gap);
  let doc = `%PDF-1.7\n${leading}`;
  signatures.forEach((s, i) => {
    const hex = s.hex ?? '308006092a864886f70d010702';
    if (i > 0) doc += filler;
    doc +=
      `${i + 1} 0 obj<</Type/Sig/M(D:${s.time})` +
      `/ByteRange ${RANGE_PLACEHOLDER}/Contents <${hex}>>>endobj\n`;
  });
  doc += '%%EOF\n';
  // Everything to here is what the signatures cover; `trailing` comes after.
  const signedLength = doc.length;

  let out = doc;
  let from = 0;
  for (;;) {
    const at = out.indexOf(RANGE_PLACEHOLDER, from);
    if (at === -1) break;
    // The Contents hex is the next <...> after the /ByteRange.
    const lt = out.indexOf('<', at);
    const c = out.indexOf('>', lt) + 1;
    const real = `[${pad10(0)} ${pad10(lt)} ${pad10(c)} ${pad10(signedLength - c)}]`;
    out = out.slice(0, at) + real + out.slice(at + RANGE_PLACEHOLDER.length);
    from = at + real.length;
  }

  // ASCII throughout, so string offsets above are byte offsets here.
  return new TextEncoder().encode(out + trailing);
}

const oneSignature = (over: Partial<Parameters<typeof buildPdf>[0]> = {}) =>
  buildPdf({ signatures: [{ time: '20240115103000' }], ...over });

describe('detectSignatures', () => {
  it('returns an empty array for an empty buffer', () => {
    expect(detectSignatures(new Uint8Array())).toEqual([]);
  });

  it('returns an empty array for a PDF with no signatures', () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF');
    expect(detectSignatures(bytes)).toEqual([]);
  });

  it('ignores a /ByteRange that is not followed by a well-formed array', () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\n/ByteRange nonsense\n%%EOF');
    expect(detectSignatures(bytes)).toEqual([]);
  });

  it('finds a signature and reads its signing time', () => {
    const found = detectSignatures(oneSignature());
    expect(found).toHaveLength(1);
    expect(found[0].signingTime).toBe('2024-01-15T10:30:00');
  });

  it('reports coversWholeDocument when nothing follows the signed ranges', () => {
    expect(detectSignatures(oneSignature())[0].coversWholeDocument).toBe(true);
  });

  it('reports whitespace after the signed ranges as still covering', () => {
    expect(detectSignatures(oneSignature({ trailing: '\n\r\t ' }))[0].coversWholeDocument).toBe(
      true,
    );
  });

  it('reports content appended after signing as not covering', () => {
    const bytes = oneSignature({ trailing: '\n2 0 obj<</Tampered true>>endobj\n' });
    expect(detectSignatures(bytes)[0].coversWholeDocument).toBe(false);
  });

  it('finds every signature in a document signed more than once', () => {
    const bytes = buildPdf({
      signatures: [{ time: '20240115103000' }, { time: '20240220141500' }],
    });
    const found = detectSignatures(bytes);
    expect(found).toHaveLength(2);
    expect(found.map((s) => s.signingTime)).toEqual(['2024-01-15T10:30:00', '2024-02-20T14:15:00']);
  });

  it('scans a large buffer without materialising it as a string', () => {
    // 8MB of filler ahead of the signature. The previous implementation built a
    // JS string per byte of the whole file (then flattened a second full-size
    // copy for the first regex); this pins that the scan works on a buffer far
    // larger than any window it is allowed to decode.
    const bytes = oneSignature({ leading: ' '.repeat(8 * 1024 * 1024) });
    const found = detectSignatures(bytes);
    expect(found).toHaveLength(1);
    expect(found[0].signingTime).toBe('2024-01-15T10:30:00');
    expect(found[0].coversWholeDocument).toBe(true);
  });

  it('stops after 50 signatures', () => {
    const signatures = Array.from({ length: 60 }, () => ({ time: '20240115103000' }));
    expect(detectSignatures(buildPdf({ signatures, gap: 0 }))).toHaveLength(50);
  });
});
