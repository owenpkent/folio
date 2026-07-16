import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

/**
 * Generate the test fixtures into e2e/fixtures. Regenerated on every run so
 * nothing binary is committed.
 */
export default async function globalSetup(): Promise<void> {
  await writeFixture('e2e/fixtures/form.pdf', await buildEmptyForm());
  await writeFixture('e2e/fixtures/filled-form.pdf', await buildFilledForm());
}

async function writeFixture(path: string, bytes: Uint8Array): Promise<void> {
  const out = resolve(path);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, bytes);
}

/** A two-page PDF with one empty fillable text field. */
async function buildEmptyForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const page = doc.addPage([420, 560]);
  page.drawText('Folio end-to-end form', { x: 40, y: 500, size: 18, font });
  page.drawText('Name:', { x: 40, y: 452, size: 12, font });

  const nameField = doc.getForm().createTextField('name');
  nameField.addToPage(page, { x: 100, y: 446, width: 220, height: 22 });

  const page2 = doc.addPage([420, 560]);
  page2.drawText('Page two', { x: 40, y: 500, size: 18, font });

  return doc.save();
}

/**
 * A single page whose only content is three text fields that already hold
 * values, with their appearance streams baked in — a form filled by some other
 * application, which is the case that exposed field text being rendered twice
 * (once into the canvas, once as the overlaid DOM input).
 *
 * The page deliberately carries no other content, so any ink on the rendered
 * canvas is a form widget that should have been left to the annotation layer.
 * See the "does not paint filled field values" test in smoke.spec.ts.
 *
 * Each field also carries a /TU entry — the human-readable label a real
 * authoring tool writes when its author labels the field — so the suite can
 * assert the fields get accessible names from it.
 */
async function buildFilledForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();

  const fields: [string, string, string, number][] = [
    ['fullName', 'Full legal name', 'Jonathan Q. Fillingsworth', 650],
    ['address', 'Street address', '1600 Pennsylvania Avenue NW', 600],
    ['city', 'City and state', 'Washington, District of Columbia', 550],
  ];
  for (const [name, label, value, y] of fields) {
    const field = form.createTextField(name);
    field.setText(value);
    field.addToPage(page, { x: 60, y, width: 480, height: 28, font });
    // PDF.js reads /TU off the widget annotation with a plain (non-inherited)
    // lookup, so it has to sit on the widget, not only on the parent field.
    for (const widget of field.acroField.getWidgets()) {
      widget.dict.set(PDFName.of('TU'), PDFString.of(label));
    }
    field.acroField.dict.set(PDFName.of('TU'), PDFString.of(label));
  }
  form.updateFieldAppearances(font);

  return doc.save();
}
