// @vitest-environment node
import { readFileSync } from 'node:fs';

import * as asn1js from 'asn1js';
import { PDFDocument } from 'pdf-lib';
import * as pkijs from 'pkijs';
import { describe, expect, it } from 'vitest';

import { generateSelfSignedP12, parseP12 } from './cert';
import { signPdf } from './sign';
import { detectSignatures } from './verify';

/** Created by the node-forge based implementation, before it was removed. */
const LEGACY_P12 = new Uint8Array(
  readFileSync(new URL('./__fixtures__/legacy-node-forge.p12', import.meta.url)),
);
const LEGACY_PASSPHRASE = 'legacy-pass';

async function tinyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawText('Folio signing test');
  return doc.save();
}

const ab = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/**
 * Independently check the signature a signed PDF carries: the CMS digest
 * attribute must equal SHA-256 of the ByteRange content, and the RSA signature
 * over the DER signed attributes must verify under the embedded certificate.
 */
async function verifyPdfSignature(signed: Uint8Array) {
  const text = Buffer.from(signed).toString('latin1');
  const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  expect(range).not.toBeNull();
  const [a, b, c, d] = range!.slice(1).map(Number);
  const content = Buffer.concat([signed.subarray(a, a + b), signed.subarray(c, c + d)]);
  const hex = /<([0-9A-Fa-f]+)/.exec(text.slice(a + b, c))![1];
  // Placeholder is zero padded; the CMS blob is only the leading DER element.
  const cms = Buffer.from(hex, 'hex');

  const parsed = asn1js.fromBER(ab(new Uint8Array(cms)));
  expect(parsed.offset).not.toBe(-1);
  const contentInfo = new pkijs.ContentInfo({ schema: parsed.result });
  const signedData = new pkijs.SignedData({ schema: contentInfo.content });
  expect(signedData.encapContentInfo.eContent).toBeUndefined(); // detached

  const signerInfo = signedData.signerInfos[0];
  expect(signerInfo.digestAlgorithm.algorithmId).toBe('2.16.840.1.101.3.4.2.1'); // SHA-256
  const attrs = signerInfo.signedAttrs!.attributes;
  expect(attrs.map((x) => x.type)).toEqual([
    '1.2.840.113549.1.9.3', // contentType
    '1.2.840.113549.1.9.5', // signingTime
    '1.2.840.113549.1.9.4', // messageDigest
  ]);

  const messageDigest = new Uint8Array(
    (attrs[2].values[0] as asn1js.OctetString).valueBlock.valueHexView,
  );
  const expected = new Uint8Array(
    await crypto.subtle.digest('SHA-256', ab(new Uint8Array(content))),
  );
  expect(Buffer.from(messageDigest).toString('hex')).toBe(Buffer.from(expected).toString('hex'));

  // The signature covers the DER of the attributes re-tagged as a SET OF.
  const signedBytes = new Uint8Array(signerInfo.signedAttrs!.toSchema().toBER(false));
  signedBytes[0] = 0x31;

  const cert = signedData.certificates![0] as pkijs.Certificate;
  const spki = new Uint8Array(cert.subjectPublicKeyInfo.toSchema().toBER(false));
  const publicKey = await crypto.subtle.importKey(
    'spki',
    ab(spki),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signature = new Uint8Array(signerInfo.signature.valueBlock.valueHexView);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    ab(signature),
    ab(signedBytes),
  );
  return { ok, certificateCount: signedData.certificates!.length };
}

describe('cryptographic signing', () => {
  it('generates a self-signed identity and validates its passphrase', async () => {
    const { p12, summary } = await generateSelfSignedP12({
      commonName: 'Ada Lovelace',
      organization: 'Analytical, Inc.',
      email: 'ada@example.com',
      passphrase: 'pw',
    });
    expect(summary.commonName).toBe('Ada Lovelace');
    expect(summary.organization).toBe('Analytical, Inc.');
    expect(summary.selfSigned).toBe(true);
    expect(summary.serialNumber).toMatch(/^[0-9a-f]{32}$/);
    const days = (Date.parse(summary.validTo) - Date.parse(summary.validFrom)) / 86_400_000;
    expect(Math.round(days)).toBe(365);

    // Correct passphrase parses; wrong one throws.
    expect((await parseP12(p12, 'pw')).commonName).toBe('Ada Lovelace');
    await expect(parseP12(p12, 'wrong')).rejects.toThrow();
  }, 20000);

  it('round trips: generate, export, import, sign, detect and verify', async () => {
    const pdfBytes = await tinyPdf();
    const { p12 } = await generateSelfSignedP12({ commonName: 'Ada Lovelace', passphrase: 'pw' });
    const imported = await parseP12(p12, 'pw');
    expect(imported.commonName).toBe('Ada Lovelace');

    const signed = await signPdf(pdfBytes, p12, 'pw', { reason: 'Test', name: 'Ada Lovelace' });
    expect(signed.length).toBeGreaterThan(pdfBytes.length);

    const found = detectSignatures(signed);
    expect(found).toHaveLength(1);
    expect(found[0].coversWholeDocument).toBe(true);
    expect(found[0].signerName).toBe('Ada Lovelace');

    const check = await verifyPdfSignature(signed);
    expect(check.ok).toBe(true);
    expect(check.certificateCount).toBe(1);
  }, 30000);

  it('rejects a signature whose bytes were altered', async () => {
    const { p12 } = await generateSelfSignedP12({ commonName: 'Ada Lovelace', passphrase: 'pw' });
    const signed = await signPdf(await tinyPdf(), p12, 'pw');
    // Flip a byte inside the signed range; the digest check must now fail.
    const tampered = new Uint8Array(signed);
    tampered[20] ^= 0xff;
    await expect(verifyPdfSignature(tampered)).rejects.toThrow();
  }, 30000);

  it('fails to sign with the wrong passphrase', async () => {
    const { p12 } = await generateSelfSignedP12({ commonName: 'Ada Lovelace', passphrase: 'pw' });
    await expect(signPdf(await tinyPdf(), p12, 'nope')).rejects.toThrow();
  }, 30000);

  describe('legacy .p12 written by node-forge', () => {
    it('still imports', async () => {
      const summary = await parseP12(LEGACY_P12, LEGACY_PASSPHRASE);
      expect(summary.commonName).toBe('Legacy Forge Signer');
      expect(summary.organization).toBe('Folio Legacy');
      expect(summary.selfSigned).toBe(true);
      await expect(parseP12(LEGACY_P12, 'wrong')).rejects.toThrow();
    });

    it('still signs, and the signature verifies', async () => {
      const signed = await signPdf(await tinyPdf(), LEGACY_P12, LEGACY_PASSPHRASE);
      const found = detectSignatures(signed);
      expect(found).toHaveLength(1);
      expect(found[0].signerName).toBe('Legacy Forge Signer');
      expect(found[0].coversWholeDocument).toBe(true);
      expect((await verifyPdfSignature(signed)).ok).toBe(true);
    }, 30000);
  });
});
