import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfirmHost } from './ConfirmHost';
import { askConfirmation, useConfirmStore } from './confirmStore';

const OPTIONS = {
  title: 'Text recognition is still running',
  message: '40 of 300 pages have recognized text so far.',
  confirmLabel: 'Save anyway',
  cancelLabel: 'Wait for recognition',
};

describe('ConfirmHost', () => {
  afterEach(() => {
    cleanup();
    useConfirmStore.setState({ pending: null });
  });

  it('renders nothing until there is a question', () => {
    render(<ConfirmHost />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('names and describes itself from the question, and focuses the cautious answer', async () => {
    render(<ConfirmHost />);
    const answered = askConfirmation(OPTIONS);

    // alertdialog, not dialog: this interrupts to report a condition the user
    // needs to act on, which is what the role is for.
    const dialog = await screen.findByRole('alertdialog', { name: OPTIONS.title });
    expect(dialog).toHaveAccessibleDescription(OPTIONS.message);

    // The decline must come first in DOM order, because useFocusTrap focuses
    // the first tabbable: Enter on a dialog the user has not read then takes
    // the reversible path. Asserted as order rather than as focus because
    // useFocusTrap filters on `offsetParent`, which jsdom leaves null for
    // everything (it runs no layout), so nothing is focusable here at all. The
    // focus itself needs a real engine; see e2e.
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual([OPTIONS.cancelLabel, OPTIONS.confirmLabel]);

    await userEvent.setup().click(screen.getByRole('button', { name: OPTIONS.confirmLabel }));
    await expect(answered).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('declines on Escape', async () => {
    render(<ConfirmHost />);
    const answered = askConfirmation(OPTIONS);
    await screen.findByRole('alertdialog');

    await userEvent.setup().keyboard('{Escape}');

    // Declining, never confirming: the question is always "shall I go ahead
    // with something that may not be what you want", so a dismissal must not
    // be read as a yes.
    await expect(answered).resolves.toBe(false);
  });
});
