import { Signer } from '@signpdf/utils';
import * as asn1js from 'asn1js';
import { Buffer } from 'buffer';
import * as pkijs from 'pkijs';

import { loadSigningIdentity } from './cert';

const OID_DATA = '1.2.840.113549.1.7.1';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/**
 * Detached CMS SignedData for a PDF (`adbe.pkcs7.detached`), built with pkijs and
 * WebCrypto: SHA-256, RSASSA-PKCS1-v1_5, signer certificate (and any chain from
 * the .p12) embedded.
 *
 * The signed attributes are contentType, signingTime, messageDigest, in that
 * order, which is the order EU validators expect and what the previous
 * node-forge based signer emitted.
 */
export class WebCryptoP12Signer extends Signer {
  private readonly p12: Uint8Array;
  private readonly passphrase: string;

  constructor(p12: Uint8Array, passphrase: string) {
    super();
    this.p12 = p12;
    this.passphrase = passphrase;
  }

  override async sign(pdfBuffer: Buffer, signingTime: Date = new Date()): Promise<Buffer> {
    const { privateKey, certificates } = await loadSigningIdentity(this.p12, this.passphrase);
    const certs = certificates.map((der) => {
      const parsed = asn1js.fromBER(toArrayBuffer(der));
      if (parsed.offset === -1) throw new Error('Invalid certificate in the .p12 file');
      return new pkijs.Certificate({ schema: parsed.result });
    });
    const signerCert = certs[0];

    const contentDigest = await crypto.subtle.digest('SHA-256', toArrayBuffer(pdfBuffer));

    const signedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 0,
      attributes: [
        new pkijs.Attribute({
          type: OID_CONTENT_TYPE,
          values: [new asn1js.ObjectIdentifier({ value: OID_DATA })],
        }),
        new pkijs.Attribute({
          type: OID_SIGNING_TIME,
          values: [new asn1js.UTCTime({ valueDate: signingTime })],
        }),
        new pkijs.Attribute({
          type: OID_MESSAGE_DIGEST,
          values: [new asn1js.OctetString({ valueHex: contentDigest })],
        }),
      ],
    });

    const signedData = new pkijs.SignedData({
      version: 1,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID_DATA }),
      signerInfos: [
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({
            issuer: signerCert.issuer,
            serialNumber: signerCert.serialNumber,
          }),
          signedAttrs,
        }),
      ],
      certificates: certs,
    });

    // The signature is computed over the DER of the signed attributes, which
    // already commit to the PDF bytes through messageDigest.
    await signedData.sign(privateKey, 0, 'SHA-256');

    const contentInfo = new pkijs.ContentInfo({
      contentType: pkijs.ContentInfo.SIGNED_DATA,
      content: signedData.toSchema(true),
    });
    return Buffer.from(contentInfo.toSchema().toBER(false));
  }
}
