import { PDFDocument, PDFHexString } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PdfCore from '@/core/pdf';
import type { PdfDocumentInfo } from '@/core/pdf';

const { invoke, saveDialog, mockSaveDocument, exported } = vi.hoisted(() => {
  // Stand-in export output. It has to look enough like a PDF to clear the
  // "would this destroy the user's document" gate in saveDocument.ts: the
  // header at offset 0 and a length no real document could be under.
  const exportedBytes = new Uint8Array(400);
  exportedBytes.set(new TextEncoder().encode('%PDF-1.7\n'), 0);
  return {
    invoke: vi.fn(),
    saveDialog: vi.fn(),
    exported: exportedBytes,
    // Explicit return type widens this to plain `Uint8Array` (not the narrower
    // `Uint8Array<ArrayBuffer>` TS infers for an array literal): pdf-lib's own
    // `.save()` returns the wider type, and mockResolvedValueOnce below needs
    // to accept its output.
    mockSaveDocument: vi.fn(async (): Promise<Uint8Array> => exportedBytes),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: saveDialog }));
// Stub the engine so exporting needs no real document; with no edits,
// signatures, OCR, or annotations staged, these bytes come back as-is. Tests
// that need real, loadable PDF bytes (to inspect a baked trailer /ID) override
// this per call with mockSaveDocument.mockResolvedValueOnce(...).
vi.mock('@/core/pdf', async (orig) => {
  const actual = (await orig()) as typeof PdfCore;
  return { ...actual, getEngine: () => ({ saveDocument: mockSaveDocument }) };
});

import { useToastStore } from '@/components/common';
import { useSignatureStore } from '@/features/signatures';
import { useDocumentStore } from '@/state/documentStore';

import { exportDocument, saveBytes, saveDocumentInPlace } from './saveDocument';

const info: PdfDocumentInfo = { numPages: 1, fingerprint: 'fp', name: 'report.pdf' };

/** Toggle the marker `isTauri()` checks for (jsdom has no Tauri shell). */
function setTauri(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

describe('saveDocumentInPlace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDocumentStore.getState().reset();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => setTauri(false));

  it('writes back to the source path in the desktop app', async () => {
    setTauri(true);
    useDocumentStore.setState({ status: 'ready', info, sourcePath: 'C:/docs/report.pdf' });
    invoke.mockResolvedValue(undefined);

    await saveDocumentInPlace();

    // The bytes are the whole payload, not a field in an arguments object:
    // that is what makes Tauri send them as a raw binary body instead of
    // expanding them into a JSON array of numbers. The destination rides in a
    // header because a raw body cannot carry a sibling argument.
    expect(invoke).toHaveBeenCalledWith('write_document', exported, {
      headers: { 'Folio-Path': 'C%3A%2Fdocs%2Freport.pdf' },
    });
    expect(saveDialog).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toMatchObject([{ kind: 'success' }]);
  });

  it('percent-encodes a non-ASCII destination path', async () => {
    setTauri(true);
    // Header values are ASCII only, so an unencoded path here would be rejected
    // by the Rust side rather than saved.
    useDocumentStore.setState({ status: 'ready', info, sourcePath: 'C:/Users/Ömer/report.pdf' });
    invoke.mockResolvedValue(undefined);

    await saveDocumentInPlace();

    const [, , options] = invoke.mock.calls[0];
    const header = (options as { headers: Record<string, string> }).headers['Folio-Path'];
    expect(header).toBe('C%3A%2FUsers%2F%C3%96mer%2Freport.pdf');
    expect(decodeURIComponent(header)).toBe('C:/Users/Ömer/report.pdf');
    // eslint-disable-next-line no-control-regex
    expect(header).not.toMatch(/[^\x00-\x7f]/);
  });

  it('falls back to the save-a-copy dialog when there is no source path', async () => {
    setTauri(true);
    useDocumentStore.setState({ status: 'ready', info, sourcePath: null });
    saveDialog.mockResolvedValue(null); // user cancels the dialog

    await saveDocumentInPlace();

    expect(saveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'report (filled).pdf' }),
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('never invokes the Tauri write outside the desktop app', async () => {
    setTauri(false);
    useDocumentStore.setState({ status: 'ready', info, sourcePath: 'C:/docs/report.pdf' });
    // jsdom lacks blob URLs and navigation; stub both so the browser
    // download fallback runs without jsdom's not-implemented noise.
    const createObjectURL = vi.fn(() => 'blob:folio');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await saveDocumentInPlace();

    expect(invoke).not.toHaveBeenCalled();
    expect(saveDialog).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('surfaces a write failure as an error toast', async () => {
    setTauri(true);
    useDocumentStore.setState({ status: 'ready', info, sourcePath: 'C:/docs/report.pdf' });
    invoke.mockRejectedValue(new Error('disk full'));

    await saveDocumentInPlace();

    expect(useToastStore.getState().toasts).toMatchObject([{ kind: 'error' }]);
  });

  it('does nothing without a ready document', async () => {
    setTauri(true);
    await saveDocumentInPlace();
    expect(invoke).not.toHaveBeenCalled();
    expect(saveDialog).not.toHaveBeenCalled();
  });
});

describe('refusing to write a payload that is not a document', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDocumentStore.getState().reset();
    useToastStore.setState({ toasts: [] });
    setTauri(true);
    useDocumentStore.setState({ status: 'ready', info, sourcePath: 'C:/docs/report.pdf' });
    invoke.mockResolvedValue(undefined);
  });
  afterEach(() => setTauri(false));

  /** `length` bytes carrying `prefix` at offset 0. */
  function payload(prefix: string, length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    bytes.set(new TextEncoder().encode(prefix), 0);
    return bytes;
  }

  // Save-in-place replaces the only copy of the document, so an export that
  // came back empty or truncated is unrecoverable data loss, not a no-op.
  const rejected: Array<[string, Uint8Array]> = [
    ['nothing at all', new Uint8Array(0)],
    ['a handful of bytes', new Uint8Array([1, 2, 3])],
    ['a truncated document', payload('%PDF-1.7\n', 64)],
    ['something that is not a PDF at all', payload('<!doctype html>', 400)],
  ];

  for (const [what, bytes] of rejected) {
    it(`refuses to save ${what} over the open document`, async () => {
      mockSaveDocument.mockResolvedValueOnce(bytes);

      await saveDocumentInPlace();

      expect(invoke).not.toHaveBeenCalled();
      // Silence here would look exactly like a successful save that did
      // nothing; the user has to be told the file was left alone.
      expect(useToastStore.getState().toasts).toMatchObject([{ kind: 'error' }]);
    });
  }

  it('refuses at saveBytes too, which is where the signing flow writes', async () => {
    // Signed bytes go out to @signpdf and come back, so they never pass
    // through the export guard.
    const ok = await saveBytes(new Uint8Array(0), 'report (signed).pdf');

    expect(ok).toBe(false);
    expect(saveDialog).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toMatchObject([{ kind: 'error' }]);
  });

  it('lets a real export through', async () => {
    await saveDocumentInPlace();

    expect(invoke).toHaveBeenCalledOnce();
    expect(useToastStore.getState().toasts).toMatchObject([{ kind: 'success' }]);
  });
});

describe('exportDocument document identity', () => {
  // A valid 1x1 transparent PNG (same fixture bake.test.ts uses for image edits).
  const PNG_1x1 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  const oneSignature = {
    id: 'sig-1',
    pageNumber: 1,
    dataUrl: PNG_1x1,
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
    createdAt: 0,
  };

  /**
   * A one-page PDF whose trailer /ID is the given hex pair, standing in for a
   * real file's original producer-assigned ID.
   */
  async function sourcePdfWithId(id: [string, string]): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(id[0]), PDFHexString.of(id[1])]);
    return doc.save();
  }

  /** Pull the trailer's /ID hex pair back out of raw saved PDF bytes. */
  function extractTrailerId(bytes: Uint8Array): [string, string] | null {
    const text = new TextDecoder('latin1').decode(bytes);
    const match = /\/ID\s*\[\s*<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>\s*\]/.exec(text);
    return match ? [match[1], match[2]] : null;
  }

  beforeEach(() => useSignatureStore.getState().reset());
  afterEach(() => useSignatureStore.getState().reset());

  it('mints a fresh trailer /ID when it bakes overlay content', async () => {
    const sourceId: [string, string] = ['ab'.repeat(16), 'cd'.repeat(16)];
    const source = await sourcePdfWithId(sourceId);
    mockSaveDocument.mockResolvedValueOnce(source);
    useSignatureStore.setState({ signatures: [oneSignature] });

    const out = await exportDocument();

    const baked = extractTrailerId(out);
    // Assert the shape too, not just that it changed: a dropped or malformed
    // /ID would also read as "not the source ID" and pass vacuously.
    expect(baked).not.toBeNull();
    expect(baked?.[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(baked?.[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(baked).not.toEqual(sourceId);
  });

  it('produces a different ID on each successive export of the same source', async () => {
    const sourceId: [string, string] = ['ab'.repeat(16), 'cd'.repeat(16)];
    const source = await sourcePdfWithId(sourceId);
    useSignatureStore.setState({ signatures: [oneSignature] });

    mockSaveDocument.mockResolvedValueOnce(source);
    const id1 = extractTrailerId(await exportDocument());
    mockSaveDocument.mockResolvedValueOnce(source);
    const id2 = extractTrailerId(await exportDocument());

    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    expect(id1).not.toEqual(id2);
  });

  it('leaves the source /ID untouched on the pass-through path with nothing staged to bake', async () => {
    const sourceId: [string, string] = ['ab'.repeat(16), 'cd'.repeat(16)];
    const source = await sourcePdfWithId(sourceId);
    mockSaveDocument.mockResolvedValueOnce(source);
    // Signature/edit/OCR/annotation stores are all empty (reset above), so
    // exportDocument takes its early pass-through return, untouched.

    const out = await exportDocument();

    expect(out).toBe(source);
    expect(extractTrailerId(out)).toEqual(sourceId);
  });
});
