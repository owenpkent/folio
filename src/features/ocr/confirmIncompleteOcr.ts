import { askConfirmation } from '@/components/common/confirmStore';

import { useOcrStore } from './store';

/** Which bake path is asking, so the question names what is about to happen. */
export type OcrExportAction = 'save' | 'print' | 'sign';

const WORDING: Record<OcrExportAction, { doing: string; confirmLabel: string; result: string }> = {
  save: { doing: 'Saving now', confirmLabel: 'Save anyway', result: 'the copy' },
  print: { doing: 'Printing now', confirmLabel: 'Print anyway', result: 'the printout' },
  sign: { doing: 'Signing now', confirmLabel: 'Sign anyway', result: 'the signed copy' },
};

/**
 * Ask before baking an OCR text layer that is still being filled in.
 *
 * Recognition deliberately does not block Save, Print, or signing: it writes
 * only its own per-page sidecar and leaves the page map alone, so the document
 * mutation lock lets a `content` operation overlap a `sidecar` one (see
 * state/documentMutationStore.ts). That is what keeps a run that can take
 * minutes on a long document from freezing half the app.
 *
 * The cost of allowing the overlap is that the export is a snapshot: it bakes
 * the pages recognized so far and leaves the rest image-only. Each page's words
 * are correct, so nothing in the output is *wrong* -- but a copy saved 40 pages
 * into a 300-page run is searchable for 40 pages and silently not for the other
 * 260, and the reader has no way to tell which. Every other bake path in Folio
 * treats quietly incomplete output as the failure worth the most effort to
 * avoid, so this asks rather than deciding on the user's behalf.
 *
 * Returns true when there is nothing to warn about (the common case: no run in
 * flight) or the user chose to go ahead, and false when they would rather wait.
 * Ask BEFORE taking the mutation lock: this is a human-scale wait.
 */
export async function confirmIncompleteOcr(action: OcrExportAction): Promise<boolean> {
  const { status, pages, progress } = useOcrStore.getState();
  if (status !== 'running') return true;

  const total = progress.total;
  // A single-page run (`ocr.recognizePage`) is over in seconds, so a dialog
  // would be more interruption than the warning is worth.
  if (total <= 1) return true;

  const done = Object.keys(pages).length;
  const { doing, confirmLabel, result } = WORDING[action];
  const pageWord = done === 1 ? 'page has' : 'pages have';

  return askConfirmation({
    title: 'Text recognition is still running',
    message:
      `${done} of ${total} ${pageWord} recognized text so far. ${doing} bakes only those; ` +
      `the rest stay image-only, so ${result} will not be fully searchable. ` +
      'Waiting lets the run finish first.',
    confirmLabel,
    cancelLabel: 'Wait for recognition',
  });
}
