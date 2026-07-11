import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { Buffer } from 'buffer';
import { PDFDocument } from 'pdf-lib';

export interface SignMetadata {
  reason?: string;
  location?: string;
  contactInfo?: string;
  name?: string;
}

/**
 * Apply a cryptographic digital signature (PKCS#7 detached) to a PDF.
 *
 * A signature placeholder is added with pdf-lib, then @signpdf computes the CMS
 * SignedData over the document byte range using the private key from the .p12.
 * The result is a signed PDF that PDF readers (including Acrobat) recognize.
 *
 * Note: this must be the last modification to the file. The signature covers
 * the whole document, so any later edit invalidates it.
 */
export async function signPdf(
  bytes: Uint8Array,
  p12: Uint8Array,
  passphrase: string,
  meta: SignMetadata = {},
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(bytes);

  pdflibAddPlaceholder({
    pdfDoc,
    reason: meta.reason || 'Signed with Folio',
    contactInfo: meta.contactInfo || '',
    name: meta.name || '',
    location: meta.location || '',
  });

  // Object streams must be disabled so the signer can locate the ByteRange.
  const withPlaceholder = await pdfDoc.save({ useObjectStreams: false });

  const signer = new P12Signer(Buffer.from(p12), { passphrase });
  const signed = await signpdf.sign(Buffer.from(withPlaceholder), signer);
  return new Uint8Array(signed);
}
