import { beforeEach, describe, expect, it } from 'vitest';

import { pickAndReadDocument, pickAndReadDocuments, sourceFromFile } from './openDocument';

// isTauri() is false under jsdom (no __TAURI_INTERNALS__ on window), so both
// pickers exercise the browser fallback: a hidden <input type="file"> this
// module creates, appends, and clicks. These tests drive that same element
// from the outside, the way a real file picker would hand control back.

/** The hidden input the picker under test just created and clicked. Both
 * pickers append synchronously (inside the Promise executor, before the
 * first await), so it exists in the DOM the instant the picker is called. */
function theHiddenFileInput(): HTMLInputElement {
  const input = document.body.querySelector('input[type="file"]');
  if (!input) throw new Error('Expected a hidden file input to have been created');
  return input as HTMLInputElement;
}

function selectFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}

function cancelPicker(input: HTMLInputElement): void {
  input.dispatchEvent(new Event('cancel'));
}

beforeEach(() => {
  // Guard against a prior test leaving its input in the DOM (it shouldn't --
  // both pickers remove it on change/cancel -- but a false pass here would
  // otherwise be silent).
  document.body.querySelectorAll('input[type="file"]').forEach((el) => el.remove());
});

describe('pickAndReadDocument (single-file browser fallback)', () => {
  it('resolves with the chosen file, read into bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = new File([bytes], 'report.pdf', { type: 'application/pdf' });

    const promise = pickAndReadDocument();
    selectFiles(theHiddenFileInput(), [file]);

    const source = await promise;
    expect(source).not.toBeNull();
    expect(source?.kind).toBe('bytes');
    if (source?.kind === 'bytes') {
      expect(source.name).toBe('report.pdf');
      expect(Array.from(source.data)).toEqual([1, 2, 3, 4]);
    }
  });

  it('removes the hidden input from the DOM once a file is chosen', async () => {
    const file = new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' });
    const promise = pickAndReadDocument();
    selectFiles(theHiddenFileInput(), [file]);
    await promise;

    expect(document.body.querySelector('input[type="file"]')).toBeNull();
  });

  it('resolves null when the picker is cancelled', async () => {
    const promise = pickAndReadDocument();
    cancelPicker(theHiddenFileInput());

    expect(await promise).toBeNull();
    expect(document.body.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('pickAndReadDocuments (multi-file browser fallback)', () => {
  it('resolves with every chosen file, in order', async () => {
    const a = new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' });
    const b = new File([new Uint8Array([2])], 'b.pdf', { type: 'application/pdf' });

    const promise = pickAndReadDocuments();
    const input = theHiddenFileInput();
    expect(input.multiple).toBe(true);
    selectFiles(input, [a, b]);

    const sources = await promise;
    expect(sources.map((s) => s.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('resolves an empty array when the picker is cancelled', async () => {
    const promise = pickAndReadDocuments();
    cancelPicker(theHiddenFileInput());

    expect(await promise).toEqual([]);
  });
});

describe('sourceFromFile', () => {
  it('reads a browser File into a bytes source', async () => {
    const file = new File([new Uint8Array([5, 6, 7])], 'x.pdf', { type: 'application/pdf' });
    const source = await sourceFromFile(file);
    expect(source).toEqual({ kind: 'bytes', data: new Uint8Array([5, 6, 7]), name: 'x.pdf' });
  });
});
