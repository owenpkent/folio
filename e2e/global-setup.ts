import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * Generate the test fixture: a two-page PDF with a fillable text field, written
 * to e2e/fixtures/form.pdf. Regenerated on every run so nothing binary is
 * committed.
 */
export default async function globalSetup(): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const page = doc.addPage([420, 560]);
  page.drawText('Folio end-to-end form', { x: 40, y: 500, size: 18, font });
  page.drawText('Name:', { x: 40, y: 452, size: 12, font });

  const nameField = doc.getForm().createTextField('name');
  nameField.addToPage(page, { x: 100, y: 446, width: 220, height: 22 });

  const page2 = doc.addPage([420, 560]);
  page2.drawText('Page two', { x: 40, y: 500, size: 18, font });

  const bytes = await doc.save();
  const out = resolve('e2e/fixtures/form.pdf');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, bytes);
}
