// Seed generators, bundled and called by fuzz/make-seeds.mjs. Uses the app's own
// signing code so the seeds are real, not hand-typed stubs.
import { PDFDocument } from 'pdf-lib';

import { generateSelfSignedP12 } from '../src/features/signing/cert';
import { signPdf } from '../src/features/signing/sign';

export async function tinyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]).drawText('Folio fuzz seed', { x: 20, y: 100, size: 12 });
  return doc.save({ useObjectStreams: false });
}

export async function generatedP12(): Promise<Buffer> {
  const { p12 } = await generateSelfSignedP12({ commonName: 'Fuzz Seed', passphrase: 'pw' });
  return Buffer.from(p12);
}

export async function signedPdf(p12: Uint8Array): Promise<Buffer> {
  return Buffer.from(
    await signPdf(await tinyPdf(), p12, 'pw', { reason: 'seed', name: 'Fuzz Seed' }),
  );
}

export const contentStreams = {
  text: 'q\n1 0 0 1 72 700 cm\nBT\n/F1 12 Tf\n14 TL\n0 0 Td\n(Hello, world) Tj\nT*\n[(Kern) -120 (ing)] TJ\n(next line) \'\n1 2 (spaced) "\nET\nQ\n',
  graphics: 'q\n0.5 g\n10 10 100 50 re\nf\n1 0 0 RG\n2 w\n0 0 m\n100 100 l\nS\nQ\n',
  matrices:
    'BT\n/F2 9.5 Tf\n0.866 0.5 -0.5 0.866 100 200 Tm\n(rotated) Tj\n1 0 0 1 50 50 Tm\n<48656c6c6f> Tj\nET\n',
  form: 'q\n/Fm0 Do\nQ\nBT\n/F1 10 Tf\n(in form) Tj\nET\n',
};

export const addressText =
  'Contact: ada@example.com, or visit https://example.com/path?q=1#frag.\n' +
  '(www.example.org) <mailto:team@example.co.uk> intranet:8080 t.co/aB3xY9 bad@ @@ http://\n';
