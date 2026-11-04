import { beforeEach, describe, expect, it, vi } from 'vitest';

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

/** The note as it stands right now, or null. */
const note = () => localStorage.getItem(RESUME_KEY);

/**
 * A pending update whose install records whether the note existed when the
 * installer was launched: on Windows the process exits inside this call, so
 * that moment is the only one that counts.
 */
function pendingUpdate() {
  const seen = { noteAtInstall: null as string | null };
  const downloadAndInstall = vi.fn(async () => {
    seen.noteAtInstall = note();
  });
  vi.mocked(check).mockResolvedValue({
    version: '9.9.9',
    currentVersion: '0.8.1',
    body: '',
    downloadAndInstall,
  } as unknown as Awaited<ReturnType<typeof check>>);
  return { seen, downloadAndInstall };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(ask).mockReset();
  vi.mocked(relaunch).mockClear();
  useDocumentStore.getState().reset();
  useDocumentStore.setState({ sourcePath: PATH });
  useViewerStore.setState({ currentPage: 7 });
});

describe('checkForUpdates', () => {
  it('writes the resume note before the installer is launched', async () => {
    const { seen } = pendingUpdate();
    vi.mocked(ask).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await checkForUpdates();

    expect(seen.noteAtInstall).toBe(JSON.stringify({ path: PATH, page: 7 }));
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(note()).toBe(JSON.stringify({ path: PATH, page: 7 }));
  });

  it('writes nothing when the update is declined', async () => {
    const { downloadAndInstall } = pendingUpdate();
    vi.mocked(ask).mockResolvedValueOnce(false);

    await checkForUpdates();

    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(note()).toBeNull();
  });

  it('takes the note back when the restart is put off', async () => {
    const { seen } = pendingUpdate();
    vi.mocked(ask).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await checkForUpdates();

    expect(seen.noteAtInstall).not.toBeNull();
    expect(relaunch).not.toHaveBeenCalled();
    expect(note()).toBeNull();
  });

  it('takes the note back when the install fails', async () => {
    pendingUpdate();
    vi.mocked(check).mockResolvedValue({
      version: '9.9.9',
      currentVersion: '0.8.1',
      body: '',
      downloadAndInstall: vi.fn(async () => {
        throw new Error('network');
      }),
    } as unknown as Awaited<ReturnType<typeof check>>);
    vi.mocked(ask).mockResolvedValueOnce(true);

    await checkForUpdates();

    expect(note()).toBeNull();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('records the page the reader is on at the restart, not at the download', async () => {
    const { seen } = pendingUpdate();
    vi.mocked(ask)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        useViewerStore.setState({ currentPage: 12 });
        return true;
      });

    await checkForUpdates();

    expect(seen.noteAtInstall).toBe(JSON.stringify({ path: PATH, page: 7 }));
    expect(note()).toBe(JSON.stringify({ path: PATH, page: 12 }));
  });
});
