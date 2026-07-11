// @vitest-environment node
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { generateSelfSignedP12, parseP12 } from './cert';
import { signPdf } from './sign';
import { detectSignatures } from './verify';

async function tinyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawText('Folio signing test');
  return doc.save();
}

describe('cryptographic signing', () => {
  it('generates a self-signed identity and validates its passphrase', () => {
    const { p12, summary } = generateSelfSignedP12({ commonName: 'Ada Lovelace', passphrase: 'pw' });
    expect(summary.commonName).toBe('Ada Lovelace');
    expect(summary.selfSigned).toBe(true);

    // Correct passphrase parses; wrong one throws.
    expect(parseP12(p12, 'pw').commonName).toBe('Ada Lovelace');
    expect(() => parseP12(p12, 'wrong')).toThrow();
  }, 20000);

  it('signs a PDF and the signature is detectable and covers the document', async () => {
    const pdfBytes = await tinyPdf();
    const { p12 } = generateSelfSignedP12({ commonName: 'Ada Lovelace', passphrase: 'pw' });

    const signed = await signPdf(pdfBytes, p12, 'pw', { reason: 'Test', name: 'Ada Lovelace' });
    expect(signed.length).toBeGreaterThan(pdfBytes.length);

    const found = detectSignatures(signed);
    expect(found).toHaveLength(1);
    expect(found[0].coversWholeDocument).toBe(true);
    expect(found[0].signerName).toContain('Ada Lovelace');
  }, 30000);
});
