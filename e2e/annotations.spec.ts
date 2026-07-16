import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFString } from 'pdf-lib';

const FORM_PDF = resolve('e2e/fixtures/form.pdf');
/** Exports are kept here for the PDF/UA-1 measurement step in CI. */
const EXPORT_DIR = resolve('test-results/exports');

async function openAndHighlight(page: Page) {
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.folio-empty').getByRole('button', { name: /open document/i }).click(),
  ]);
  await chooser.setFiles(FORM_PDF);
  await expect(page.locator('.folio-page-canvas').first()).toBeVisible();
  await expect(page.locator('.folio-text-layer span').first()).toBeAttached();

  await page.evaluate(() => {
    const span = document.querySelector('.folio-text-layer span');
    if (!span) throw new Error('no text span to select');
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press('Control+Shift+H');
  await expect(page.locator('.folio-annotation--highlight')).toHaveCount(1);
}

/** Save a copy and parse it, rather than regex the bytes: pdf-lib writes object
 *  streams, so a compressed annotation dict is invisible to a raw text search
 *  and every assertion here would pass against a file containing nothing.
 *
 *  The export is also kept under test-results/exports, which is what CI feeds to
 *  veraPDF to measure the PDF/UA-1 gap (see docs/508-conformance.md). */
async function saveAndParse(page: Page, keepAs?: string): Promise<PDFDocument> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Control+s'),
  ]);
  const path = await download.path();
  if (keepAs) {
    mkdirSync(EXPORT_DIR, { recursive: true });
    copyFileSync(path!, resolve(EXPORT_DIR, keepAs));
  }
  return PDFDocument.load(readFileSync(path!));
}

function annotsOf(doc: PDFDocument, pageIndex: number): PDFDict[] {
  const raw = doc.getPage(pageIndex).node.get(PDFName.of('Annots'));
  if (!(raw instanceof PDFArray)) return [];
  return raw
    .asArray()
    .map((ref) => doc.context.lookup(ref))
    .filter((o): o is PDFDict => o instanceof PDFDict);
}

const subtypeOf = (d: PDFDict) => (d.get(PDFName.of('Subtype')) as PDFName | undefined)?.asString();
const contentsOf = (d: PDFDict) => (d.get(PDFName.of('Contents')) as PDFString | undefined)?.asString();

test('a highlight is saved as a real /Highlight annotation carrying its text', async ({ page }) => {
  await openAndHighlight(page);
  const doc = await saveAndParse(page, 'annotated.pdf');

  const highlights = annotsOf(doc, 0).filter((a) => subtypeOf(a) === '/Highlight');
  expect(highlights).toHaveLength(1);

  // /Contents is what assistive technology announces for an annotation, and what
  // PDF/UA requires of a non-widget one (ISO 14289-1 7.18, Matterhorn 28-004).
  // Flattening the highlight into the page graphics would look the same and say
  // nothing.
  expect(contentsOf(highlights[0])).toBeTruthy();

  // Quads describe the highlighted lines; without them a reader has no shape.
  const quads = highlights[0].get(PDFName.of('QuadPoints'));
  expect(quads).toBeInstanceOf(PDFArray);
  expect((quads as PDFArray).size()).toBe(8);
});

test('an annotated page declares Tabs = S, and an untouched page does not', async ({ page }) => {
  await openAndHighlight(page);
  const doc = await saveAndParse(page);

  // "Every page on which there is an annotation shall contain in its page
  // dictionary the key Tabs ... and its value shall be S" (ISO 14289-1 7.18.3).
  const tabs = doc.getPage(0).node.get(PDFName.of('Tabs')) as PDFName | undefined;
  expect(tabs?.asString()).toBe('/S');

  // Page 2 has no annotation, so it must not have been touched.
  expect(doc.getPage(1).node.get(PDFName.of('Tabs'))).toBeUndefined();
});

test('the original form field survives alongside the new annotation', async ({ page }) => {
  await openAndHighlight(page);
  const doc = await saveAndParse(page);

  // Regression guard: addAnnot must append, not replace. The page's existing
  // widget has to still be there next to the highlight.
  const subtypes = annotsOf(doc, 0).map(subtypeOf).sort();
  expect(subtypes).toEqual(['/Highlight', '/Widget']);
});
