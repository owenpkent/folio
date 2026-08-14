import { PDFDocument } from 'pdf-lib';
import { beforeEach, describe, expect, it } from 'vitest';

import { useCombineStore } from './store';

async function pdfBytes(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([100, 100]);
  return doc.save();
}

/** Let the async page-count patches queued by addFiles land. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('combine store', () => {
  beforeEach(() => {
    useCombineStore.setState({ modalOpen: false, files: [], busy: false, error: null });
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
});
