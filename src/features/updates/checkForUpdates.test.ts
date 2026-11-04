import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@/core/document/openDocument', () => ({ isTauri: () => true }));

import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';

import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { checkForUpdates } from './checkForUpdates';

const RESUME_KEY = 'folio:resume-after-update';
const PATH = 'C:\\docs\\report.pdf';
const OTHER = 'C:\\docs\\other.pdf';

/** The note as it stands right now, or null. */
const note = () => localStorage.getItem(RESUME_KEY);
const noteFor = (path: string, page: number) => JSON.stringify({ path, page });

/** A deferred step: the test decides when it completes. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A pending update whose download and install are separate, deferrable
 * steps. `install` records the note as it stood when the installer was
 * launched: on Windows the process exits inside that call, so that moment is
 * the only one that counts there.
 */
function pendingUpdate(opts: { duringDownload?: () => void; installNeverReturns?: boolean } = {}) {
  const seen = { noteAtInstall: null as string | null, installs: 0 };
  const download = vi.fn(async () => {
    opts.duringDownload?.();
  });
  const install = vi.fn(async () => {
    seen.installs += 1;
    seen.noteAtInstall = note();
    if (opts.installNeverReturns) await new Promise<never>(() => {});
  });
  const close = vi.fn(async () => {});
  vi.mocked(check).mockResolvedValue({
    version: '9.9.9',
    currentVersion: '0.8.1',
    body: '',
    download,
    install,
    close,
  } as unknown as Awaited<ReturnType<typeof check>>);
  return { seen, download, install, close };
}

/** Make the code see a Windows webview, where installing is the restart. */
function onWindows(): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0',
  );
}

/** The options of the n-th prompt shown. */
const promptOptions = (n: number) => vi.mocked(ask).mock.calls[n][1] as { kind?: string };
const promptText = (n: number) => vi.mocked(ask).mock.calls[n][0];

beforeEach(() => {
  localStorage.clear();
  vi.mocked(ask).mockReset();
  vi.mocked(relaunch).mockClear();
  useDocumentStore.getState().reset();
  useDocumentStore.setState({ sourcePath: PATH });
  useViewerStore.setState({ currentPage: 7 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkForUpdates, where the install returns (macOS, Linux)', () => {
  it('writes the note only once "Restart now" is chosen, then relaunches', async () => {
    const { seen } = pendingUpdate();
    vi.mocked(ask).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await checkForUpdates();

    expect(seen.noteAtInstall).toBeNull();
    expect(note()).toBe(noteFor(PATH, 7));
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('writes nothing, and releases the update, when it is declined', async () => {
    const { download, close } = pendingUpdate();
    vi.mocked(ask).mockResolvedValueOnce(false);

    await checkForUpdates();

    expect(download).not.toHaveBeenCalled();
    expect(note()).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('leaves no note, and releases the downloaded installer, when the restart is put off', async () => {
    const { close } = pendingUpdate();
    vi.mocked(ask).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await checkForUpdates();

    expect(relaunch).not.toHaveBeenCalled();
    expect(note()).toBeNull();
    // The installer's bytes live in the Rust resource table until closed.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('leaves no note, and releases the downloaded installer, when the install fails', async () => {
    const close = vi.fn(async () => {});
    vi.mocked(check).mockResolvedValue({
      version: '9.9.9',
      currentVersion: '0.8.1',
      body: '',
      download: vi.fn(async () => {}),
      install: vi.fn(async () => {
        throw new Error('installer refused');
      }),
      close,
    } as unknown as Awaited<ReturnType<typeof check>>);
    vi.mocked(ask).mockResolvedValueOnce(true);

    await checkForUpdates();

    expect(note()).toBeNull();
    expect(relaunch).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still releases the update when closing it fails', async () => {
    const { close } = pendingUpdate();
    close.mockRejectedValueOnce(new Error('already gone'));
    vi.mocked(ask).mockResolvedValueOnce(false);

    await expect(checkForUpdates(false)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('warns on the restart prompt about an edit made while the download ran', async () => {
    pendingUpdate({ duringDownload: () => useDocumentStore.getState().bumpDocVersion() });
    vi.mocked(ask).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await checkForUpdates();

    expect(promptOptions(0).kind).toBe('info');
    expect(promptText(1)).toContain('edited in place');
    expect(promptOptions(1).kind).toBe('warning');
  });

  it('records the page the reader is on at the restart, not at the download', async () => {
    pendingUpdate();
    vi.mocked(ask)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        useViewerStore.setState({ currentPage: 12 });
        return true;
      });

    await checkForUpdates();

    expect(note()).toBe(noteFor(PATH, 12));
  });
});

describe('checkForUpdates on Windows, where installing is the restart', () => {
  beforeEach(onWindows);

  it('says so up front and writes the note right before the installer runs', async () => {
    const { seen, install } = pendingUpdate({ installNeverReturns: true });
    vi.mocked(ask).mockResolvedValueOnce(true);

    void checkForUpdates();
    await vi.waitFor(() => expect(install).toHaveBeenCalled());

    expect(promptText(0)).toContain('Folio restarts to finish');
    expect(seen.noteAtInstall).toBe(noteFor(PATH, 7));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('records what is open when the installer runs, not what was open at the download', async () => {
    const { seen, install } = pendingUpdate({
      installNeverReturns: true,
      duringDownload: () => {
        useDocumentStore.setState({ sourcePath: OTHER });
        useViewerStore.setState({ currentPage: 3 });
      },
    });
    vi.mocked(ask).mockResolvedValueOnce(true);

    void checkForUpdates();
    await vi.waitFor(() => expect(install).toHaveBeenCalled());

    expect(seen.noteAtInstall).toBe(noteFor(OTHER, 3));
  });

  it('writes nothing when the document was closed during the download', async () => {
    const { seen, install } = pendingUpdate({
      installNeverReturns: true,
      duringDownload: () => useDocumentStore.getState().reset(),
    });
    vi.mocked(ask).mockResolvedValueOnce(true);

    void checkForUpdates();
    await vi.waitFor(() => expect(install).toHaveBeenCalled());

    expect(seen.noteAtInstall).toBeNull();
    expect(note()).toBeNull();
  });

  it('leaves nothing behind if the app is quit during the download', async () => {
    const { install } = pendingUpdate();
    const pending = deferred();
    vi.mocked(check).mockResolvedValue({
      version: '9.9.9',
      currentVersion: '0.8.1',
      body: '',
      download: vi.fn(() => pending.promise),
      install,
    } as unknown as Awaited<ReturnType<typeof check>>);
    vi.mocked(ask).mockResolvedValueOnce(true);

    void checkForUpdates();
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    await Promise.resolve();

    // Mid download: this is the state a quit would leave on disk.
    expect(note()).toBeNull();
    expect(install).not.toHaveBeenCalled();
    pending.resolve();
  });

  it('asks again before installing when the document was edited during the download', async () => {
    const { seen, install } = pendingUpdate({
      installNeverReturns: true,
      duringDownload: () => useDocumentStore.getState().bumpDocVersion(),
    });
    vi.mocked(ask).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    void checkForUpdates();
    await vi.waitFor(() => expect(install).toHaveBeenCalled());

    expect(promptOptions(0).kind).toBe('info');
    expect(promptText(1)).toContain('edited in place');
    expect(promptOptions(1).kind).toBe('warning');
    expect(seen.noteAtInstall).toBe(noteFor(PATH, 7));
  });

  it('does not install, and releases the installer, when that second question is answered "Later"', async () => {
    const { install, close } = pendingUpdate({
      duringDownload: () => useDocumentStore.getState().bumpDocVersion(),
    });
    vi.mocked(ask).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await checkForUpdates();

    expect(install).not.toHaveBeenCalled();
    expect(note()).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('warns once, at acceptance, when the document was already edited', async () => {
    useDocumentStore.getState().bumpDocVersion();
    const { install } = pendingUpdate({ installNeverReturns: true });
    vi.mocked(ask).mockResolvedValueOnce(true);

    void checkForUpdates();
    await vi.waitFor(() => expect(install).toHaveBeenCalled());

    expect(promptText(0)).toContain('edited in place');
    expect(promptOptions(0).kind).toBe('warning');
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
