// @vitest-environment node
import { readFileSync } from 'node:fs';

import * as asn1js from 'asn1js';
import { PDFDocument } from 'pdf-lib';
import * as pkijs from 'pkijs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateSelfSignedP12, parseP12 } from './cert';
import { readPkcs12, writePkcs12 } from './pkcs12';
import { signPdf } from './sign';
import { detectSignatures } from './verify';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));
}

/** Created by the node-forge based implementation, before it was removed. */
const LEGACY_P12 = fixture('legacy-node-forge.p12');
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    expect(summary.serialNumber).toMatch(/^[4-7][0-9a-f]{31}$/);
    const days = (Date.parse(summary.validTo) - Date.parse(summary.validFrom)) / 86_400_000;
    expect(Math.round(days)).toBe(365);

    // Correct passphrase parses; wrong one throws.
    expect((await parseP12(p12, 'pw')).commonName).toBe('Ada Lovelace');
    await expect(parseP12(p12, 'wrong')).rejects.toThrow();
  }, 20000);

  it('keeps the serial 16 bytes long even when the random bytes start with zeros', async () => {
    // The serial is read back from the certificate, which drops leading zero
    // octets from the INTEGER. Force the worst case rather than wait for the
    // 1-in-128 run that hits it by chance.
    const real = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      if (array instanceof Uint8Array) {
        real(array);
        if (array.length === 16) array.fill(0, 0, 2);
      }
      return array;
    });
    const { summary } = await generateSelfSignedP12({ commonName: 'Zero', passphrase: 'pw' });
    expect(summary.serialNumber).toMatch(/^40[0-9a-f]{30}$/);
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

    // node-forge fed PBKDF2 one byte per character (the low byte of each code
    // unit), not UTF-8, so a non-ASCII password derives a different AES key
    // under the two encodings. Written by node-forge 1.4.0 with
    // toPkcs12Asn1(key, [cert], 'päss', { algorithm: 'aes256' }).
    it('still imports and signs with an AES key and a non-ASCII password', async () => {
      const p12 = fixture('legacy-node-forge-aes-latin1.p12');
      const summary = await parseP12(p12, 'päss');
      expect(summary.commonName).toBe('Legacy Forge Signer');
      await expect(parseP12(p12, 'pass')).rejects.toThrow();

      const signed = await signPdf(await tinyPdf(), p12, 'päss');
      expect(detectSignatures(signed)[0].signerName).toBe('Legacy Forge Signer');
      expect((await verifyPdfSignature(signed)).ok).toBe(true);
    }, 30000);
  });

  // Exported by OpenSSL 3.5.7 from the legacy fixture's key and certificate:
  //   -macalg sha384 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES
  //   -macalg sha512 (defaults: PBES2, PBKDF2 hmacWithSHA256, AES-256-CBC)
  describe.each([
    ['SHA-384', 'openssl-mac-sha384.p12'],
    ['SHA-512', 'openssl-mac-sha512.p12'],
  ])('.p12 with a %s MAC', (_hash, name) => {
    it('imports, and rejects the wrong passphrase', async () => {
      const summary = await parseP12(fixture(name), LEGACY_PASSPHRASE);
      expect(summary.commonName).toBe('Legacy Forge Signer');
      await expect(parseP12(fixture(name), 'wrong')).rejects.toThrow(/MAC/);
    });

    it('signs, and the signature verifies', async () => {
      const signed = await signPdf(await tinyPdf(), fixture(name), LEGACY_PASSPHRASE);
      expect(detectSignatures(signed)[0].signerName).toBe('Legacy Forge Signer');
      expect((await verifyPdfSignature(signed)).ok).toBe(true);
    }, 30000);
  });

  describe('BER encoded .p12', () => {
    /**
     * Rewrite a .p12 from writePkcs12() so the encrypted certificate safe's
     * content is a constructed [0] IMPLICIT OCTET STRING split in two, as BER
     * allows. The MAC covers the rewritten bytes, so it is dropped; the reader
     * treats a missing MAC as "nothing to check".
     */
    function chunkEncryptedContent(p12: Uint8Array): Uint8Array {
      const pfx = asn1js.fromBER(ab(p12)).result as asn1js.Sequence;
      const authSafeOctets = (
        (pfx.valueBlock.value[1] as asn1js.Sequence).valueBlock.value[1] as asn1js.Constructed
      ).valueBlock.value[0] as asn1js.OctetString;
      const authSafe = asn1js.fromBER(authSafeOctets.valueBlock.valueHexView.slice().buffer)
        .result as asn1js.Sequence;
      const certSafe = authSafe.valueBlock.value[0] as asn1js.Sequence;
      const encryptedData = (certSafe.valueBlock.value[1] as asn1js.Constructed).valueBlock
        .value[0] as asn1js.Sequence;
      const encryptedContentInfo = encryptedData.valueBlock.value[1] as asn1js.Sequence;
      const encrypted = encryptedContentInfo.valueBlock.value[2] as asn1js.Primitive;
      const bytes = encrypted.valueBlock.valueHexView;
      expect(encrypted.idBlock.tagClass).toBe(3);
      expect(encrypted.idBlock.isConstructed).toBe(false);
      const half = Math.floor(bytes.length / 2);
      encryptedContentInfo.valueBlock.value[2] = new asn1js.Constructed({
        idBlock: { tagClass: 3, tagNumber: 0 },
        value: [
          new asn1js.OctetString({ valueHex: bytes.slice(0, half).buffer }),
          new asn1js.OctetString({ valueHex: bytes.slice(half).buffer }),
        ],
      });
      const rewritten = new asn1js.Sequence({
        value: [
          pfx.valueBlock.value[0],
          new asn1js.Sequence({
            value: [
              new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' }),
              new asn1js.Constructed({
                idBlock: { tagClass: 3, tagNumber: 0 },
                value: [new asn1js.OctetString({ valueHex: authSafe.toBER() })],
              }),
            ],
          }),
        ],
      });
      return new Uint8Array(rewritten.toBER());
    }

    it('reads a certificate safe whose encrypted content is a constructed [0]', async () => {
      const { p12 } = await generateSelfSignedP12({ commonName: 'Chunked', passphrase: 'pw' });
      const der = await readPkcs12(p12, 'pw');
      const ber = await readPkcs12(chunkEncryptedContent(p12), 'pw');
      expect(ber.certificates).toHaveLength(1);
      expect(Buffer.from(ber.certificates[0])).toEqual(Buffer.from(der.certificates[0]));
      expect(Buffer.from(ber.pkcs8!)).toEqual(Buffer.from(der.pkcs8!));
    }, 20000);

    it('reads a chunked universal OCTET STRING too', async () => {
      const { p12 } = await generateSelfSignedP12({ commonName: 'Chunked', passphrase: 'pw' });
      // Same idea, applied to the key bag's plain `data` content.
      const pfx = asn1js.fromBER(ab(p12)).result as asn1js.Sequence;
      const authSafeOctets = (
        (pfx.valueBlock.value[1] as asn1js.Sequence).valueBlock.value[1] as asn1js.Constructed
      ).valueBlock.value[0] as asn1js.OctetString;
      const bytes = authSafeOctets.valueBlock.valueHexView;
      const half = Math.floor(bytes.length / 2);
      const chunked = new asn1js.OctetString({
        idBlock: { isConstructed: true },
        value: [
          new asn1js.OctetString({ valueHex: bytes.slice(0, half).buffer }),
          new asn1js.OctetString({ valueHex: bytes.slice(half).buffer }),
        ],
      });
      const rewritten = new asn1js.Sequence({
        value: [
          pfx.valueBlock.value[0],
          new asn1js.Sequence({
            value: [
              new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' }),
              new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [chunked] }),
            ],
          }),
        ],
      });
      const ber = await readPkcs12(new Uint8Array(rewritten.toBER()), 'pw');
      expect(ber.certificates).toHaveLength(1);
      expect(ber.pkcs8).not.toBeNull();
    }, 20000);

    it('round trips through writePkcs12 and readPkcs12', async () => {
      const { p12 } = await generateSelfSignedP12({ commonName: 'Round', passphrase: 'pw' });
      const { certificates, pkcs8 } = await readPkcs12(p12, 'pw');
      const again = await writePkcs12(certificates[0], pkcs8!, 'pw2');
      const back = await readPkcs12(again, 'pw2');
      expect(Buffer.from(back.certificates[0])).toEqual(Buffer.from(certificates[0]));
      expect(Buffer.from(back.pkcs8!)).toEqual(Buffer.from(pkcs8!));
    }, 20000);
  });
});
