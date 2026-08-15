import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Modal } from './Modal';

const press = (key: string) => userEvent.setup().keyboard(`{${key}}`);

describe('Modal', () => {
  afterEach(cleanup);

  it('renders nothing while closed', () => {
    render(
      <Modal open={false} title="Combine PDFs">
        <p>body</p>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the dialog from its title and composes its classes', () => {
    render(
      <Modal open title="Organize pages" size="wide" className="folio-organize">
        <p>body</p>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Organize pages' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.className).toBe('folio-modal folio-modal--wide folio-organize');
    expect(screen.getByRole('heading', { name: 'Organize pages' })).toBeInTheDocument();
  });

  it('dismisses on Escape and on the header close button', async () => {
    const onDismiss = vi.fn();
    render(
      <Modal open title="About Folio" onDismiss={onDismiss}>
        <p>body</p>
      </Modal>,
    );

    await press('Escape');
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('offers no close button without an onDismiss, and Escape does nothing', async () => {
    render(
      <Modal open title="Text recognition is still running">
        <p>body</p>
      </Modal>,
    );

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    // No throw, and nothing to assert beyond the dialog surviving: a question
    // with no dismiss affordance must not be escapable into an unanswered state.
    await press('Escape');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the close button but makes it inert while dismissal is disabled', async () => {
    const onDismiss = vi.fn();
    render(
      <Modal open title="Combine PDFs" onDismiss={onDismiss} dismissDisabled>
        <p>body</p>
      </Modal>,
    );

    // Disabled rather than removed, so a dialog that is winding down does not
    // shift everything beside the button as it goes.
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    await press('Escape');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('hides the close button while still honouring Escape', async () => {
    const onDismiss = vi.fn();
    render(
      <Modal open title="Preparing to print" onDismiss={onDismiss} showClose={false}>
        <p>body</p>
      </Modal>,
    );

    // The progress dialogs' shape: the footer's Cancel is the affordance, but
    // Escape still stops the run.
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    await press('Escape');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls the latest onDismiss, not the one from the render that armed Escape', async () => {
    // The stale-closure trap this primitive exists to absorb. CombineModal's
    // dismiss() branches on `busy`, so a listener that captured the closure
    // from the first render would keep closing the modal after a merge had
    // started, instead of asking that merge to stop.
    const seen: number[] = [];
    function Harness() {
      const [count, setCount] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setCount((c) => c + 1)}>
            bump
          </button>
          <Modal open title="Combine PDFs" onDismiss={() => seen.push(count)}>
            <p>body</p>
          </Modal>
        </>
      );
    }
    render(<Harness />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'bump' }));
    await user.click(screen.getByRole('button', { name: 'bump' }));
    await user.keyboard('{Escape}');

    expect(seen).toEqual([2]);
  });
});
