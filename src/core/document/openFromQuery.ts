import type { DocumentSource } from '@/core/pdf';
import { loadSource } from '@/state/actions';

import { isTauri } from './openDocument';

/** Schemes the viewer will fetch. Anything else is refused rather than handed to `fetch`. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Read the PDF URL from `#file=` (preferred) or `?file=`.
 *
 * The fragment form is read verbatim, not through `URLSearchParams`. The
 * browser extension substitutes the matched URL into the fragment un-encoded,
 * and a real PDF URL routinely contains `&` and `=`
 * (`/download?doc=42&fmt=pdf`). Parsing that as a query string would truncate
 * the URL at the first `&` and silently fetch the wrong thing. `?file=` keeps
 * the query-string reading, because anything arriving that way is encoded.
 */
function readFileParam(): string | null {
  const marker = '#file=';
  const { hash, search } = window.location;
  if (hash.startsWith(marker)) return hash.slice(marker.length) || null;
  return new URLSearchParams(search).get('file');
}

/** Resolve against the page and confirm the scheme is one we are willing to fetch. */
function safeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw, window.location.href);
    return ALLOWED_SCHEMES.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function basename(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.split('/').pop() || '') || 'Document.pdf';
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
 *
 * The URL arrives from a page navigation and is therefore untrusted: any site
 * can link to the viewer with a fragment of its choosing. It is scheme-checked
 * before it reaches `fetch`, which keeps `javascript:`, `data:`, and `file:` out.
 * `file:` is refused deliberately rather than by oversight -- local PDFs are not
 * handled yet, and would need their own interception path.
 */
export async function openFromQueryParam(): Promise<void> {
  if (isTauri()) return;
  const raw = readFileParam();
  if (!raw) return;
  const url = safeUrl(raw);
  if (!url) return;
  try {
    const res = await fetch(url.href);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const source: DocumentSource = {
      kind: 'bytes',
      data: new Uint8Array(await res.arrayBuffer()),
      name: basename(url),
    };
    await loadSource(source);
  } catch {
    // Leave the empty state; the user can still open a file manually.
  }
}
