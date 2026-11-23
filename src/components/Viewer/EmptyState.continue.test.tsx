import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OpenDocument from '@/core/document/openDocument';

const tauri = vi.hoisted(() => ({ value: true }));
vi.mock('@/core/document/openDocument', async (orig) => ({
  ...(await orig<typeof OpenDocument>()),
  isTauri: () => tauri.value,
}));
const openPath = vi.hoisted(() => vi.fn());
vi.mock('@/features/fileopen/openFromLaunch', () => ({ openPath }));

import { writeLastDocument } from '@/features/readingPosition/lastDocument';
import { useDocumentStore } from '@/state/documentStore';

import { EmptyState } from './EmptyState';

const NOTE_KEY = 'folio.lastDocument';
const note = { path: 'C:\\docs\\statement.pdf', name: 'statement.pdf', page: 47 };

describe('EmptyState Continue button', () => {
  beforeEach(() => {
    localStorage.clear();
    tauri.value = true;
    openPath.mockReset();
    useDocumentStore.setState({ booting: false });
  });
  afterEach(cleanup);

  it('offers the last document, named with its page, as the primary control', () => {
    writeLastDocument(note);
    render(<EmptyState />);
    const button = screen.getByRole('button', { name: 'Continue: statement.pdf, page 47' });
    expect(button).toHaveClass('folio-button--primary', 'folio-empty__continue');
    expect(screen.getByRole('button', { name: /open document/i })).toHaveClass(
      'folio-button--ghost',
    );
  });

  it('opens that path when clicked, and keeps the note', async () => {
    writeLastDocument(note);
    openPath.mockResolvedValue(true);
    render(<EmptyState />);
    fireEvent.click(screen.getByRole('button', { name: /^continue/i }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(note.path));
    expect(localStorage.getItem(NOTE_KEY)).not.toBeNull();
  });

  it('clears the note and stops offering it when the file will not open', async () => {
    writeLastDocument(note);
    openPath.mockResolvedValue(false);
    render(<EmptyState />);
    fireEvent.click(screen.getByRole('button', { name: /^continue/i }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^continue/i })).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem(NOTE_KEY)).toBeNull();
    expect(screen.getByRole('button', { name: /open document/i })).toHaveClass(
      'folio-button--primary',
    );
  });

  it('is absent outside Tauri, with no note, with an invalid note, and while booting', () => {
    writeLastDocument(note);
    tauri.value = false;
    const { unmount } = render(<EmptyState />);
    expect(screen.queryByRole('button', { name: /^continue/i })).not.toBeInTheDocument();
    unmount();

    tauri.value = true;
    localStorage.clear();
    render(<EmptyState />);
    expect(screen.queryByRole('button', { name: /^continue/i })).not.toBeInTheDocument();
    cleanup();

    localStorage.setItem(NOTE_KEY, JSON.stringify({ ...note, path: '\\\\server\\share\\a.pdf' }));
    render(<EmptyState />);
    expect(screen.queryByRole('button', { name: /^continue/i })).not.toBeInTheDocument();
    cleanup();

    writeLastDocument(note);
    useDocumentStore.setState({ booting: true });
    render(<EmptyState />);
    expect(screen.queryByRole('button', { name: /^continue/i })).not.toBeInTheDocument();
  });
});
