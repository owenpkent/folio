import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

/** A child that throws the given value during render, whatever it is. */
function Boom({ thrown }: { thrown: unknown }): never {
  throw thrown;
}

describe('ErrorBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs every caught render error itself, on top of this component's
    // own log. Silenced so a passing suite is not a wall of expected stacks.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>the document</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('the document')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the message from a thrown Error instead of a blank window', () => {
    render(
      <ErrorBoundary>
        <Boom thrown={new Error('page 4 has no content stream')} />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Folio hit an unexpected error');
    expect(alert).toHaveTextContent('page 4 has no content stream');
  });

  it('moves focus to the fallback heading, which is where the message starts', () => {
    render(
      <ErrorBoundary>
        <Boom thrown={new Error('boom')} />
      </ErrorBoundary>,
    );

    // Without this the user is left focused on an element React has just
    // unmounted: nothing announces, and the next Tab starts from nowhere.
    expect(screen.getByRole('heading', { name: 'Folio hit an unexpected error' })).toHaveFocus();
  });

  it('announces itself as an alert', () => {
    render(
      <ErrorBoundary>
        <Boom thrown={new Error('boom')} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows a thrown string, which is not an Error and has no .message', () => {
    render(
      <ErrorBoundary>
        <Boom thrown="the worker went away" />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('the worker went away');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { code: 500 }],
    ['a number', 42],
    ['an Error with an empty message', new Error('')],
  ])('falls back to a generic line when %s is thrown', (_what, thrown) => {
    render(
      <ErrorBoundary>
        <Boom thrown={thrown} />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    // The fallback still renders and still says something. Reading `.message`
    // off any of these gives undefined, and String() gives "[object Object]".
    expect(alert).toHaveTextContent('Folio hit an unexpected error');
    expect(alert).toHaveTextContent('No further details are available.');
    expect(alert).not.toHaveTextContent('undefined');
    expect(alert).not.toHaveTextContent('[object Object]');
  });

  it('keeps internal paths and stack traces out of the visible message', () => {
    // A made-up account name, not whoever happens to run the suite: the point
    // is the shape of the path, and the repository should not carry a real
    // developer's home directory around in a fixture.
    const thrown = new Error(
      'Failed to fetch dynamically imported module: file:///C:/Users/jrivera/dev/folio/dist/pdf.mjs\n' +
        '    at loadWorker (C:\\Users\\jrivera\\dev\\folio\\dist\\index.js:12:9)',
    );

    render(
      <ErrorBoundary>
        <Boom thrown={thrown} />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Failed to fetch dynamically imported module: pdf.mjs');
    // The install location names the account on Windows, and this is a screen
    // people screenshot into bug reports.
    expect(alert.textContent).not.toContain('jrivera');
    expect(alert.textContent).not.toContain('at loadWorker');
  });

  it('still logs the raw throw and the component stack for whoever has to debug it', () => {
    const thrown = new Error('boom');

    render(
      <ErrorBoundary>
        <Boom thrown={thrown} />
      </ErrorBoundary>,
    );

    expect(consoleError).toHaveBeenCalledWith(
      '[folio] unhandled render error',
      thrown,
      expect.stringContaining('Boom'),
    );
  });

  it('recovers through the reload button rather than re-throwing in a loop', async () => {
    // Stubbed because jsdom has no navigation; the assertion is that the click
    // reaches it exactly once.
    const reload = vi.fn();
    const original = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });

    try {
      let stillBroken = true;
      function Flaky() {
        if (stillBroken) throw new Error('first mount only');
        return <p>the document</p>;
      }

      const first = render(
        <ErrorBoundary>
          <Flaky />
        </ErrorBoundary>,
      );
      expect(screen.getByRole('alert')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Reload Folio' }));

      expect(reload).toHaveBeenCalledOnce();
      // The fallback holds: it does not retry the children in place, which
      // would hit the same throw and reload again, and again.
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(reload).toHaveBeenCalledOnce();

      // What the reload actually does: start over with a fresh tree. With the
      // cause gone the app comes back, so the recovery is real rather than a
      // button that returns to the same crash.
      first.unmount();
      stillBroken = false;
      render(
        <ErrorBoundary>
          <Flaky />
        </ErrorBoundary>,
      );

      expect(screen.getByText('the document')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, 'location', original);
    }
  });
});
