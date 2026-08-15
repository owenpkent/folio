import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OpenDocument from '@/core/document/openDocument';
import { useDocumentStore } from '@/state/documentStore';

const { pickAndReadDocuments, loadSource } = vi.hoisted(() => ({
  pickAndReadDocuments: vi.fn(async () => ({
    sources: [] as { name: string; data: Uint8Array }[],
    failed: [] as string[],
  })),
  loadSource: vi.fn(async () => undefined),
}));

vi.mock('@/core/document/openDocument', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof OpenDocument;
  return { ...actual, pickAndReadDocuments };
});
vi.mock('@/state/actions', () => ({ loadSource }));
vi.mock('@/a11y/announcer', () => ({ announce: vi.fn() }));

import { CombineModal } from './CombineModal';
import { runCombine } from './commands';
import { useCombineStore } from './store';

async function pdfBytes(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([100, 100]);
  return doc.save();
}

const IDLE_COMBINE_STATE = {
  modalOpen: false,
  files: [],
  busy: false,
  error: null,
  progress: { current: 0, total: 0 },
  cancelRequested: false,
};

beforeEach(() => {
  pickAndReadDocuments.mockClear();
  loadSource.mockClear();
  useCombineStore.setState(IDLE_COMBINE_STATE);
  useDocumentStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useCombineStore.setState(IDLE_COMBINE_STATE);
  useDocumentStore.getState().reset();
});

describe('CombineModal', () => {
  it('renders nothing while closed', () => {
    render(<CombineModal />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape', () => {
    useCombineStore.getState().open();
    render(<CombineModal />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(useCombineStore.getState().modalOpen).toBe(false);
  });

  it('disables Combine with fewer than two files', async () => {
    const bytes = await pdfBytes(1);
    useCombineStore.getState().open([{ name: 'a.pdf', bytes }]);
    render(<CombineModal />);

    expect(screen.getByRole('button', { name: 'Combine' })).toBeDisabled();
  });

  it('enables Combine once two files are staged', async () => {
    const a = await pdfBytes(1);
    const b = await pdfBytes(1);
    useCombineStore.getState().open([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
    ]);
    render(<CombineModal />);

    expect(await screen.findByRole('button', { name: 'Combine' })).toBeEnabled();
    expect(screen.getByText('a.pdf')).toBeInTheDocument();
    expect(screen.getByText('b.pdf')).toBeInTheDocument();
  });

  it('shows an inline error instead of closing on failure', async () => {
    const a = await pdfBytes(1);
    const bad = new Uint8Array([1, 2, 3]);
    useCombineStore.getState().open([
      { name: 'a.pdf', bytes: a },
      { name: 'bad.pdf', bytes: bad },
    ]);
    render(<CombineModal />);

    // Driven through runCombine directly rather than the button, because the
    // button is (correctly) disabled while any file is still being read or has
    // failed to read -- that pre-submit guard is the next test. This one is
    // about runCombine's own catch path: a merge that fails once started has
    // to leave the modal open with the reason showing, not close over it.
    await runCombine();

    expect(await screen.findByRole('alert')).toHaveTextContent(/bad\.pdf/);
    expect(useCombineStore.getState().modalOpen).toBe(true);
    expect(loadSource).not.toHaveBeenCalled();
  });

  it('disables Combine once a staged file fails to validate', async () => {
    const a = await pdfBytes(1);
    const bad = new Uint8Array([1, 2, 3]);
    useCombineStore.getState().open([
      { name: 'a.pdf', bytes: a },
      { name: 'bad.pdf', bytes: bad },
    ]);
    render(<CombineModal />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Combine' })).toBeDisabled();
    });
  });

  it('calls the picker when "Add PDFs…" is clicked', () => {
    useCombineStore.getState().open();
    render(<CombineModal />);

    fireEvent.click(screen.getByRole('button', { name: 'Add PDFs…' }));

    expect(pickAndReadDocuments).toHaveBeenCalledTimes(1);
  });

  it('does not report success when loadSource resolves into an error state', async () => {
    // The real loadSource never rejects -- it catches its own failures into
    // doc.setError and resolves normally (see state/actions.ts) -- so this
    // mock reproduces that shape instead of throwing, which is exactly the
    // case runCombine has to notice by checking documentStore afterward.
    loadSource.mockImplementationOnce(async () => {
      useDocumentStore.getState().setError('Could not open document');
    });
    const a = await pdfBytes(1);
    const b = await pdfBytes(1);
    useCombineStore.getState().open([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
    ]);
    render(<CombineModal />);

    // Both files have to finish staging before Combine is clickable at all.
    const combine = await screen.findByRole('button', { name: 'Combine' });
    await waitFor(() => expect(combine).toBeEnabled());
    fireEvent.click(combine);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(useCombineStore.getState().modalOpen).toBe(true);
    expect(useCombineStore.getState().busy).toBe(false);
  });

  it('requests cancellation instead of closing outright while a merge is in flight', async () => {
    const a = await pdfBytes(1);
    const b = await pdfBytes(1);
    useCombineStore.getState().open([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
    ]);
    useCombineStore.getState().setBusy(true);
    render(<CombineModal />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Busy still true: dismissing while a merge is running only requests
    // cancellation, it does not hide the modal out from under the run.
    expect(useCombineStore.getState().modalOpen).toBe(true);
    expect(useCombineStore.getState().cancelRequested).toBe(true);
  });
});
