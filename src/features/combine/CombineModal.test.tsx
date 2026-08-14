import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OpenDocument from '@/core/document/openDocument';

const { pickAndReadDocuments, loadSource } = vi.hoisted(() => ({
  pickAndReadDocuments: vi.fn(async () => [] as { name: string; data: Uint8Array }[]),
  loadSource: vi.fn(async () => undefined),
}));

vi.mock('@/core/document/openDocument', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof OpenDocument;
  return { ...actual, pickAndReadDocuments };
});
vi.mock('@/state/actions', () => ({ loadSource }));
vi.mock('@/a11y/announcer', () => ({ announce: vi.fn() }));

import { CombineModal } from './CombineModal';
import { useCombineStore } from './store';

async function pdfBytes(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([100, 100]);
  return doc.save();
}

beforeEach(() => {
  pickAndReadDocuments.mockClear();
  loadSource.mockClear();
  useCombineStore.setState({ modalOpen: false, files: [], busy: false, error: null });
});

afterEach(() => {
  cleanup();
  useCombineStore.setState({ modalOpen: false, files: [], busy: false, error: null });
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

    fireEvent.click(await screen.findByRole('button', { name: 'Combine' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/bad\.pdf/);
    expect(useCombineStore.getState().modalOpen).toBe(true);
    expect(loadSource).not.toHaveBeenCalled();
  });

  it('calls the picker when "Add PDFs…" is clicked', () => {
    useCombineStore.getState().open();
    render(<CombineModal />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add PDFs…' }));

    expect(pickAndReadDocuments).toHaveBeenCalledTimes(1);
  });
});
