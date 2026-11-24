/**
 * Updating from the crash screen.
 *
 * The normal update check runs from the app's root component and talks to the
 * user through the app's own UI (stores, toasts, dialogs). When the app itself
 * fails to render, none of that runs, and a broken build can never be replaced
 * by a fixed one: 0.9.0 crashed on launch and so never asked for the update
 * that fixed it. This is the path that still works then. It uses nothing but
 * the updater and process plugins, which talk to the Rust side directly, so it
 * shares no state with whatever broke; the crash screen
 * (components/common/ErrorBoundary.tsx) supplies the only UI.
 */
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

/** Whether this is the desktop app, read straight off the window: no app module involved. */
export function canSelfUpdate(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** A newer release, or null when there is none, when this is not the desktop app, or on any failure. */
export async function findCrashUpdate(): Promise<Update | null> {
  if (!canSelfUpdate()) return null;
  try {
    return await check();
  } catch (error) {
    console.warn('[updates] crash-screen check failed:', error);
    return null;
  }
}

/**
 * Download and install `update`, then restart into it. On Windows installing
 * is the restart: the plugin hands over to the installer and this process
 * exits inside `downloadAndInstall`, so the `relaunch` is for macOS and Linux.
 * Nothing is remembered for the next launch: whatever crashed is not worth
 * reopening into.
 */
export async function installCrashUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
  await relaunch();
}
