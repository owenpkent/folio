import { invoke } from '@tauri-apps/api/core';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';

import { announce } from '@/a11y/announcer';
import { pushToast } from '@/components/common';
import { isTauri } from '@/core/document/openDocument';
import type { DocumentSource } from '@/core/pdf';
import { loadSource } from '@/state/actions';

function basename(u: string): string {
  try {
    const name = decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
    return name || 'Document.pdf';
  } catch {
    return 'Document.pdf';
  }
}

/**
 * Handle a `folio://open?url=<encoded pdf url>` deep link: download the PDF
 * through the Rust `fetch_pdf` command (bypasses the webview CSP/CORS) and load
 * it into the viewer.
 */
async function handleUrls(urls: string[]): Promise<void> {
  for (const raw of urls) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'folio:') continue;

    const target = parsed.searchParams.get('url');
    if (!target) continue;

    try {
      pushToast('Opening from browser...', 'info');
      const buffer = await invoke<ArrayBuffer>('fetch_pdf', { url: target });
      const source: DocumentSource = {
        kind: 'bytes',
        data: new Uint8Array(buffer),
        name: basename(target),
      };
      await loadSource(source);
      announce(`Opened ${source.name}`);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      pushToast(`Could not open the PDF: ${messageText}`, 'error');
    }
    return; // one document per activation
  }
}

/**
 * Register `folio://` deep-link handling (desktop only). Handles both a cold
 * start (the app was launched by the URL) and links received while running.
 * Returns a cleanup function.
 */
export async function registerDeepLinks(): Promise<() => void> {
  if (!isTauri()) return () => {};

  try {
    const initial = await getCurrent();
    if (initial && initial.length) await handleUrls(initial);
  } catch {
    // getCurrent throws when the scheme isn't registered yet (e.g. `tauri dev`).
  }

  try {
    return await onOpenUrl((urls) => {
      void handleUrls(urls);
    });
  } catch {
    return () => {};
  }
}
