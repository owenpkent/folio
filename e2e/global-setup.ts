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
  await writeFixture('e2e/fixtures/addresses.pdf', await buildAddresses());
  await writeFixture('e2e/fixtures/pages.pdf', await buildNumberedPages());
}

/** The page size every address in {@link buildAddresses} is positioned against. */
export const ADDRESSES_PAGE = { width: 420, height: 594 };

/**
 * Where each thing sits, in PDF user space, so the spec can aim a right-click
 * at it without depending on the text layer being laid out.
 */
export const ADDRESSES = {
  email: { text: 'owen@example.com', x: 60, y: 500 },
  url: { text: 'www.example.com', x: 60, y: 460 },
  /** A real /Link annotation whose target is not what the page prints over it. */
  link: {
    text: 'Click here for details',
    x: 60,
    y: 400,
    rect: [58, 394, 240, 414] as const,
    target: 'https://declared.example.com/real-target',
  },
  /**
   * Prose sharing a line with an address, drawn as a single `drawText` call so
   * PDF.js emits it as one text item -- the shape the hit test has to get
   * right. `x`/`y` mark the start of the line, well before the address itself.
   */
  prose: { text: 'For questions please contact owen2@example.com', x: 60, y: 340 },
  /**
   * In the right half of the page, so the hover hint's label -- anchored
   * under the address's own left edge by default -- is the case that flips to
   * hang from the right edge instead. Ends well short of x=420 (the page's
   * own width) on purpose: PDF.js's text extraction silently drops glyphs
   * whose position falls outside the page, so text drawn running off the
   * page edge (this fixture's first version) never fully reaches
   * getTextContent() in the first place, which made it useless for testing
   * anything downstream of that. `y` matches `email`'s, known to stay inside
   * the viewport at whatever scale fit-width actually computes (which varies
   * far more across environments than a hand guess accounts for -- 228% in
   * one real run, not the ~140% first assumed here).
   */
  rightHalf: { text: 'a@bc.co', x: 340, y: 500 },
};

/**
 * A page carrying an email address, a web address, a `/Link` annotation, a
 * line of prose that shares its text item with an address, and an address in
 * the right half of the page.
 *
 * The link's visible text says nothing about where it goes, which is the case
 * the copy row exists to make legible: the menu shows the declared target, not
 * the words printed over it. The prose line is about the hit test itself:
 * PDF.js emits one text item per line, so an address is usually not alone in
 * its item. The right-half address is about the hover hint's label: anchored
 * under the address's own edge, it hangs from whichever side keeps it off the
 * page, and links.spec.ts checks that decision directly.
 */
async function buildAddresses(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([ADDRESSES_PAGE.width, ADDRESSES_PAGE.height]);

  for (const entry of [
    ADDRESSES.email,
    ADDRESSES.url,
    ADDRESSES.link,
    ADDRESSES.prose,
    ADDRESSES.rightHalf,
  ]) {
    page.drawText(entry.text, { x: entry.x, y: entry.y, size: 14, font });
  }

  const { context } = doc;
  const annot = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [...ADDRESSES.link.rect],
      // No visible border: the point is that nothing on the page says where it goes.
      Border: [0, 0, 0],
      A: context.obj({
        Type: 'Action',
        S: 'URI',
        URI: PDFString.of(ADDRESSES.link.target),
      }),
    }),
  );
  page.node.set(PDFName.of('Annots'), context.obj([annot]));

  return doc.save();
}

async function writeFixture(path: string, bytes: Uint8Array): Promise<void> {
  const out = resolve(path);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, bytes);
}

/**
 * A two-page PDF with one empty fillable text field, a checkbox, and a radio
 * group. No fixture in this repo had ever created a checkbox or radio field
 * before, so a regression in their handling (e.g. an overlay swallowing their
 * clicks; see smoke.spec.ts) would otherwise be invisible to the suite.
 */
async function buildEmptyForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();

  const page = doc.addPage([420, 560]);
  page.drawText('Folio end-to-end form', { x: 40, y: 500, size: 18, font });
  page.drawText('Name:', { x: 40, y: 452, size: 12, font });

  const nameField = form.createTextField('name');
  nameField.addToPage(page, { x: 100, y: 446, width: 220, height: 22 });

  page.drawText('Agree to terms:', { x: 40, y: 412, size: 12, font });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 220, y: 406, width: 18, height: 18 });
  for (const widget of agree.acroField.getWidgets()) {
    widget.dict.set(PDFName.of('TU'), PDFString.of('Agree to terms'));
  }

  page.drawText('Plan:', { x: 40, y: 378, size: 12, font });
  const plan = form.createRadioGroup('plan');
  plan.addOptionToPage('basic', page, { x: 100, y: 372, width: 18, height: 18 });
  plan.addOptionToPage('pro', page, { x: 160, y: 372, width: 18, height: 18 });
  for (const widget of plan.acroField.getWidgets()) {
    widget.dict.set(PDFName.of('TU'), PDFString.of('Plan'));
  }

  const page2 = doc.addPage([420, 560]);
  page2.drawText('Page two', { x: 40, y: 500, size: 18, font });

  return doc.save();
}

/**
 * Four pages, each saying which position it started in.
 *
 * Page operations are otherwise hard to assert on: after a reorder every page
 * still renders, and only the words on them say whether the right one moved.
 * The word is the page's whole text content, so a spec can read it straight off
 * the text layer. Portrait, so a quarter turn is visible in the layout box.
 */
async function buildNumberedPages(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['ONE', 'TWO', 'THREE', 'FOUR']) {
    const page = doc.addPage([420, 594]);
    page.drawText(label, { x: 60, y: 300, size: 56, font });
  }
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
