import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PdfCore from '@/core/pdf';
import type { PdfDocumentInfo } from '@/core/pdf';

const { invoke, saveDialog } = vi.hoisted(() => ({ invoke: vi.fn(), saveDialog: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: saveDialog }));
// Stub the engine so exporting needs no real document; with no edits,
// signatures, OCR, or annotations staged, these bytes come back as-is.
vi.mock('@/core/pdf', async (orig) => {
  const actual = (await orig()) as typeof PdfCore;
  return { ...actual, getEngine: () => ({ saveDocument: async () => new Uint8Array([1, 2, 3]) }) };
});

import { useToastStore } from '@/components/common';
import { useDocumentStore } from '@/state/documentStore';

import { saveDocumentInPlace } from './saveDocument';

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

    expect(invoke).toHaveBeenCalledWith('write_document', {
      path: 'C:/docs/report.pdf',
      contents: [1, 2, 3],
    });
    expect(saveDialog).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toMatchObject([{ kind: 'success' }]);
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
