import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useDocumentStore } from '@/state/documentStore';

import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  afterEach(() => {
    cleanup();
    useDocumentStore.setState({ booting: false });
  });

  it('shows the product name and an open action', () => {
    render(<EmptyState />);
    expect(screen.getByRole('heading', { name: 'Folio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open document/i })).toBeInTheDocument();
  });

  it('shows only the branding until startup file handling settles', () => {
    useDocumentStore.setState({ booting: true });
    render(<EmptyState />);
    expect(screen.getByRole('heading', { name: 'Folio' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open document/i })).not.toBeInTheDocument();
  });

  it('reveals the open controls once booted', () => {
    useDocumentStore.setState({ booting: true });
    render(<EmptyState />);
    act(() => useDocumentStore.getState().setBooted());
    expect(screen.getByRole('button', { name: /open document/i })).toBeInTheDocument();
  });
});
