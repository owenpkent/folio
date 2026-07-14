import type { DocumentSource } from '@/core/pdf';
import { loadSource } from '@/state/actions';

import { isTauri } from './openDocument';

/** Read the PDF URL from `#file=` (preferred) or `?file=`. */
function readFileParam(): string | null {
  const fromHash = window.location.hash.startsWith('#')
    ? new URLSearchParams(window.location.hash.slice(1)).get('file')
    : null;
  return fromHash ?? new URLSearchParams(window.location.search).get('file');
}

function basename(u: string): string {
  try {
    const name = decodeURIComponent(new URL(u, window.location.href).pathname.split('/').pop() || '');
    return name || 'Document.pdf';
  } catch {
    return 'Document.pdf';
  }
}

/**
 * When Folio's web build is opened with a `#file=<pdf url>` (or `?file=`), fetch
 * and render that PDF. Used by the Folio browser extension, which redirects PDF
 * navigations to this viewer. Browser build only -- the desktop app uses deep
 * links and native dialogs.
 *
 * Cross-origin fetches depend on the caller's context: the extension grants host
 * permissions (so PDFs behind a login work); a bare web deployment is subject to
 * the target's CORS policy.
 */
export async function openFromQueryParam(): Promise<void> {
  if (isTauri()) return;
  const file = readFileParam();
  if (!file) return;
  try {
    const res = await fetch(file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const source: DocumentSource = {
      kind: 'bytes',
      data: new Uint8Array(await res.arrayBuffer()),
      name: basename(file),
    };
    await loadSource(source);
  } catch {
    // Leave the empty state; the user can still open a file manually.
  }
}
