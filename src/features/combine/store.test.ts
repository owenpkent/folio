import { PDFDocument } from 'pdf-lib';
import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_COMBINE_INPUTS } from './combineDocuments';
import { useCombineStore } from './store';

async function pdfBytes(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([100, 100]);
  return doc.save();
}

/** Let the async page-count patches queued by addFiles land. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const IDLE_STATE = {
  modalOpen: false,
  files: [],
  busy: false,
  error: null,
  progress: { current: 0, total: 0 },
  cancelRequested: false,
};

describe('combine store', () => {
  beforeEach(() => {
    useCombineStore.setState(IDLE_STATE);
  });

  it('opens empty and closes back to empty', () => {
    useCombineStore.getState().open();
    expect(useCombineStore.getState().modalOpen).toBe(true);
    expect(useCombineStore.getState().files).toEqual([]);

    useCombineStore.getState().close();
    expect(useCombineStore.getState().modalOpen).toBe(false);
    expect(useCombineStore.getState().files).toEqual([]);
  });

  it('opens seeded with files and reads their page counts asynchronously', async () => {
    const bytes = await pdfBytes(2);
    useCombineStore.getState().open([{ name: 'a.pdf', bytes }]);

    expect(useCombineStore.getState().files).toHaveLength(1);
    expect(useCombineStore.getState().files[0].pageCount).toBeUndefined();

    await flush();

    expect(useCombineStore.getState().files[0].pageCount).toBe(2);
  });

  it('drops the raw bytes of a staged file once it has been parsed', async () => {
    const bytes = await pdfBytes(1);
    useCombineStore.getState().addFiles([{ name: 'a.pdf', bytes }]);

    expect(useCombineStore.getState().files[0].bytes).toBeDefined();
    await flush();

    // Nothing reads the raw file once `doc` holds it, and keeping both meant
    // a second full copy of every staged file stayed resident for as long as
    // the modal was open, on top of the merged document being built from them.
    expect(useCombineStore.getState().files[0].doc).toBeDefined();
    expect(useCombineStore.getState().files[0].bytes).toBeUndefined();
  });

  it('refuses to stage more files while a merge is in flight', async () => {
    const bytes = await pdfBytes(1);
    useCombineStore.getState().open([{ name: 'a.pdf', bytes }]);
    await flush();
    useCombineStore.getState().setBusy(true);

    useCombineStore.getState().addFiles([{ name: 'late.pdf', bytes }]);

    // The run snapshotted its inputs before this arrived, so the row would
    // look included while being no part of the merge -- and the success path
    // calls close(), which wipes the list without warning. Saying no is
    // better than losing the file silently.
    expect(useCombineStore.getState().files.map((f) => f.name)).toEqual(['a.pdf']);
    expect(useCombineStore.getState().error).toMatch(/in progress/);
  });

  it('refuses a batch that would take the list past the file ceiling', async () => {
    const bytes = await pdfBytes(1);
    const tooMany = Array.from({ length: MAX_COMBINE_INPUTS + 1 }, (_, i) => ({
      name: `f${i}.pdf`,
      bytes,
    }));

    useCombineStore.getState().addFiles(tooMany);

    expect(useCombineStore.getState().files).toEqual([]);
    expect(useCombineStore.getState().error).toMatch(/in batches/);
  });

  it('records an error on a file that cannot be read, naming it', async () => {
    useCombineStore.getState().addFiles([{ name: 'bad.pdf', bytes: new Uint8Array([1, 2, 3]) }]);

    await flush();

    expect(useCombineStore.getState().files[0].error).toMatch(/bad\.pdf/);
    expect(useCombineStore.getState().files[0].pageCount).toBeUndefined();
  });

  it('reorders and removes files', async () => {
    const a = await pdfBytes(1);
    const b = await pdfBytes(1);
    useCombineStore.getState().addFiles([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
    ]);
    const [first, second] = useCombineStore.getState().files;

    useCombineStore.getState().moveDown(first.id);
    expect(useCombineStore.getState().files.map((f) => f.name)).toEqual(['b.pdf', 'a.pdf']);

    useCombineStore.getState().moveUp(first.id);
    expect(useCombineStore.getState().files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);

    useCombineStore.getState().removeFile(second.id);
    expect(useCombineStore.getState().files.map((f) => f.name)).toEqual(['a.pdf']);
  });

  it('does nothing moving the first file up or the last file down', async () => {
    const a = await pdfBytes(1);
    const b = await pdfBytes(1);
    useCombineStore.getState().addFiles([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
    ]);
    const [first, second] = useCombineStore.getState().files;

    useCombineStore.getState().moveUp(first.id);
    useCombineStore.getState().moveDown(second.id);

    expect(useCombineStore.getState().files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('clear empties the file list without closing the modal', () => {
    useCombineStore.setState({
      modalOpen: true,
      files: [{ id: '1', name: 'a.pdf', bytes: new Uint8Array() }],
      error: 'boom',
    });

    useCombineStore.getState().clear();

    expect(useCombineStore.getState().modalOpen).toBe(true);
    expect(useCombineStore.getState().files).toEqual([]);
    expect(useCombineStore.getState().error).toBeNull();
  });

  it('tracks busy and error state', () => {
    useCombineStore.getState().setBusy(true);
    expect(useCombineStore.getState().busy).toBe(true);

    useCombineStore.getState().setError('nope');
    expect(useCombineStore.getState().error).toBe('nope');
  });

  it('requestCancel sets cancelRequested; endRun does not clear it', () => {
    useCombineStore.getState().startRun(2);
    useCombineStore.getState().requestCancel();
    expect(useCombineStore.getState().cancelRequested).toBe(true);

    // endRun is what a cancelled run's own cleanup calls (see commands.ts's
    // runCombine finally block) -- it must not clear cancelRequested itself,
    // or a run that legitimately finishes while a cancel is *also* pending
    // (a narrow race, but the guard should not depend on winning it) would
    // silently swallow the request.
    useCombineStore.getState().endRun();
    expect(useCombineStore.getState().cancelRequested).toBe(true);
    expect(useCombineStore.getState().busy).toBe(false);
  });

  it('startRun clears a cancelRequested left over from a previous, cancelled run', () => {
    // Reproduces the bug this guards: a cancelled run leaves the modal open
    // (nothing calls close(), the only other place that resets the flag)
    // with cancelRequested still true, and nothing cleared it before this
    // fix, so clicking Combine again would poll isCancelled() and cancel
    // itself immediately, before doing any work.
    useCombineStore.getState().startRun(2);
    useCombineStore.getState().requestCancel();
    useCombineStore.getState().endRun();
    expect(useCombineStore.getState().cancelRequested).toBe(true);

    useCombineStore.getState().startRun(2);
    expect(useCombineStore.getState().cancelRequested).toBe(false);
    expect(useCombineStore.getState().busy).toBe(true);
    expect(useCombineStore.getState().progress).toEqual({ current: 0, total: 2 });
  });
});
