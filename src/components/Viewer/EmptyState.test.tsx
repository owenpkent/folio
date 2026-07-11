import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  afterEach(cleanup);

  it('shows the product name and an open action', () => {
    render(<EmptyState />);
    expect(screen.getByRole('heading', { name: 'Folio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open document/i })).toBeInTheDocument();
  });
});
