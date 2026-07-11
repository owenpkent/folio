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

function uint8ToLatin1(bytes: Uint8Array): string {
  // Chunked to avoid call-stack limits on large files.
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
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

function signingTimeNear(text: string, from: number, to: number): string | null {
  const window = text.slice(Math.max(0, from), to);
  const m = window.match(/\/M\s*\(D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/** Detect digital signatures in a PDF and extract basic, verifiable info. */
export function detectSignatures(bytes: Uint8Array): DetectedSignature[] {
  const text = uint8ToLatin1(bytes);
  const byteRange = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const results: DetectedSignature[] = [];

  let match: RegExpExecArray | null;
  while ((match = byteRange.exec(text)) !== null && results.length < 50) {
    const a = +match[1];
    const b = +match[2];
    const c = +match[3];
    const d = +match[4];

    // The signature Contents hex sits in the gap between the two signed ranges.
    const gap = text.slice(a + b, c);
    const hex = gap.match(/<([0-9A-Fa-f]+)/)?.[1] ?? '';

    const after = text.slice(c + d);
    results.push({
      signerName: hex ? signerFromContents(hex) : null,
      signingTime: signingTimeNear(text, match.index - 1000, c + 500),
      coversWholeDocument: after.replace(/\s/g, '').length === 0,
    });
  }

  return results;
}
