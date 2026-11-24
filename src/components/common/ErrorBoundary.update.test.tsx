import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const plugins = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: plugins.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: plugins.relaunch }));

import { ErrorBoundary } from './ErrorBoundary';

/** A child that always throws while rendering, as 0.9.0's whole app did. */
function Boom(): never {
  throw new Error("Cannot read properties of null (reading 'useCallback')");
}

function setTauri(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function crash() {
  return render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );
}

/**
 * A build that crashes on launch could not be replaced before: the update
 * check runs inside the tree that crashed. The crash screen now checks by
 * itself and offers what it finds.
 */
describe('ErrorBoundary update offer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    plugins.check.mockReset();
    plugins.relaunch.mockReset();
  });
  afterEach(() => {
    setTauri(false);
    vi.restoreAllMocks();
  });

  it('offers a newer release, and installs and restarts when asked', async () => {
    setTauri(true);
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    plugins.check.mockResolvedValue({ version: '0.9.1', downloadAndInstall });
    crash();

    const update = await screen.findByRole('button', { name: 'Update to 0.9.1 and restart' });
    expect(plugins.check).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Folio 0.9.1 is available.');
    // Reload stays, but as the second choice: the same build crashes the same way.
    expect(screen.getByRole('button', { name: 'Reload Folio' })).toHaveClass(
      'folio-crash__action--quiet',
    );
    // Focus is still where the alert starts, not pulled to the new button.
    expect(screen.getByRole('heading')).toHaveFocus();

    await userEvent.click(update);
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(plugins.relaunch).toHaveBeenCalledOnce();
  });

  // The real entry point (main.tsx) wraps everything in StrictMode, which in
  // development mounts, unmounts and remounts the boundary. The offer has to
  // survive that, for a crash at startup and for one later on.
  it('offers the update under StrictMode, as main.tsx renders it', async () => {
    setTauri(true);
    plugins.check.mockResolvedValue({ version: '0.9.1', downloadAndInstall: vi.fn() });
    render(
      <StrictMode>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </StrictMode>,
    );
    expect(
      await screen.findByRole('button', { name: 'Update to 0.9.1 and restart' }),
    ).toBeInTheDocument();
  });

  it('offers the update under StrictMode when the crash comes after startup', async () => {
    setTauri(true);
    plugins.check.mockResolvedValue({ version: '0.9.1', downloadAndInstall: vi.fn() });
    let broken = false;
    function Later() {
      if (broken) throw new Error('later');
      return <p>the document</p>;
    }
    const view = render(
      <StrictMode>
        <ErrorBoundary>
          <Later />
        </ErrorBoundary>
      </StrictMode>,
    );
    expect(screen.getByText('the document')).toBeInTheDocument();
    broken = true;
    view.rerender(
      <StrictMode>
        <ErrorBoundary>
          <Later />
        </ErrorBoundary>
      </StrictMode>,
    );
    expect(
      await screen.findByRole('button', { name: 'Update to 0.9.1 and restart' }),
    ).toBeInTheDocument();
  });

  it('says so when the install fails, and keeps Reload', async () => {
    setTauri(true);
    const downloadAndInstall = vi.fn().mockRejectedValue(new Error('signature mismatch'));
    plugins.check.mockResolvedValue({ version: '0.9.1', downloadAndInstall });
    crash();

    await userEvent.click(await screen.findByRole('button', { name: /^Update to 0\.9\.1/ }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Folio 0.9.1 could not be installed: signature mismatch',
      ),
    );
    expect(plugins.relaunch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reload Folio' })).toBeEnabled();
  });

  it('shows nothing extra when there is no update, or the check fails', async () => {
    setTauri(true);
    plugins.check.mockResolvedValueOnce(null);
    const first = crash();
    await waitFor(() => expect(plugins.check).toHaveBeenCalledOnce());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload Folio' })).not.toHaveClass(
      'folio-crash__action--quiet',
    );
    first.unmount();

    plugins.check.mockRejectedValueOnce(new Error('offline'));
    crash();
    await waitFor(() => expect(plugins.check).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not check outside the desktop app', async () => {
    crash();
    await Promise.resolve();
    expect(plugins.check).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
