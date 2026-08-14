import { announce } from '@/a11y/announcer';
import type { DocumentSource } from '@/core/pdf';
import { loadSource } from '@/state/actions';
import { useDocumentStore } from '@/state/documentStore';

import { downloadBytes } from './downloadBytes';
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

/**
 * True if `hostname` (as `URL.hostname` returns it: IPv4 already normalized to
 * canonical dotted-decimal, IPv6 literals bracketed, e.g. `[::1]`) names a
 * loopback, private, link-local, or well-known cloud-metadata address, or a
 * `.local`/`.localhost` name.
 *
 * This is the browser-side counterpart to `is_disallowed_ip` in
 * `src-tauri/src/lib.rs`, which the desktop `fetch_pdf` command uses to block
 * SSRF against internal services and metadata endpoints. It cannot do what
 * that command does: resolve the host itself, then pin the connection to the
 * validated address. `fetch` resolves and connects in one step with nothing
 * in between to hook, so a hostname that resolves to a public address now and
 * a private one moments later (DNS rebinding) is not caught by this, or by
 * anything else reachable from here. What this closes is the direct case: a
 * literal private/loopback/link-local/metadata address or hostname, typed or
 * navigated to by whoever chose the `#file=` URL.
 */
function isDisallowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  // GCP's metadata hostname; AWS/Azure/DigitalOcean expose metadata only at
  // the link-local address the IPv4 check below already covers.
  if (host === 'metadata.google.internal') return true;

  if (host.startsWith('[') && host.endsWith(']')) return isDisallowedIPv6(host.slice(1, -1));
  const v4 = parseIPv4(host);
  return v4 ? isDisallowedIPv4(v4) : false;
}

/** Parse a canonical dotted-decimal IPv4 address. This is the only form
 * `URL.hostname` produces for an IPv4 host, whatever base (decimal, hex,
 * octal) the original text used, so no other form needs handling here. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? (octets as [number, number, number, number]) : null;
}

/** Mirrors the IPv4 arm of `is_disallowed_ip` in `src-tauri/src/lib.rs`. */
function isDisallowedIPv4([a, b]: readonly [number, number, number, number]): boolean {
  return (
    a === 0 || // 0.0.0.0/8: unspecified + "this network"
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) || // link-local -- includes the 169.254.169.254 cloud metadata address
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 carrier-grade NAT
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    a >= 240 // reserved, including 255.255.255.255 broadcast
  );
}

/**
 * Mirrors the IPv6 arm of `is_disallowed_ip`. `URL.hostname` always
 * serializes an IPv6 literal to its canonical compressed form, so an
 * IPv4-mapped address always reads as `::ffff:HHHH:HHHH` (two hex groups)
 * here, never dotted -- that is the one shape this function assumes rather
 * than checks for.
 */
function isDisallowedIPv6(addr: string): boolean {
  const host = addr.toLowerCase();
  if (host === '::' || host === '::1') return true;

  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isDisallowedIPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }

  // Every range checked below has a non-zero first hextet, so a leading "::"
  // (a run of zero groups) never lands in one and needs no unpacking here.
  const firstGroup = host.startsWith('::') ? '0' : host.slice(0, host.indexOf(':'));
  const first = parseInt(firstGroup, 16) || 0;
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

/** Resolve against the page, and confirm the scheme and host are ones we are
 * willing to fetch. */
function safeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw, window.location.href);
    if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
    if (isDisallowedHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

/** Decoding can reintroduce separators that were percent-encoded in the path
 * (`/a%2Fb.pdf`), and this feeds an `<a download>`. Browsers sanitize that
 * attribute themselves, but a filename is not the place to rely on it. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/]/g, '_').replace(/^\.+/, '');
}

/** The `filename*` (RFC 5987, preferred) or `filename` parameter of a
 * Content-Disposition header, or null if it has neither. */
function filenameFromContentDisposition(header: string): string | null {
  const extended = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // Malformed percent-encoding; fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/**
 * Best-effort filename for a fetched document: the server's
 * Content-Disposition if it sent one, otherwise the URL's last path segment,
 * with `.pdf` appended when neither source gave an extension and the
 * response says it is one. Both headers sit unread on `res` before this --
 * fed only the URL, this PR's own headline shape (`/download?doc=42&fmt=pdf`,
 * `/api/v1/documents/42`) produces "download" or "42", an extension-less
 * filename that also becomes the window title.
 */
function basename(url: URL, res: Response): string {
  const disposition = res.headers.get('content-disposition');
  const fromHeader = disposition ? sanitizeFilename(filenameFromContentDisposition(disposition) ?? '') : '';
  if (fromHeader) return fromHeader;

  let fromPath: string;
  try {
    fromPath = sanitizeFilename(decodeURIComponent(url.pathname.split('/').pop() || ''));
  } catch {
    fromPath = '';
  }
  if (!fromPath) return 'Document.pdf';
  if (/\.[a-z0-9]{1,5}$/i.test(fromPath)) return fromPath;
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  return type.includes('pdf') ? `${fromPath}.pdf` : fromPath;
}

/**
 * The URL this document was fetched from, when it arrived via `#file=`, and
 * the fingerprint of the document it was fetched for.
 *
 * Held so the viewer can offer the original back to the user. The browser
 * extension redirects PDF navigations here, including ones the site meant as a
 * download, so "give me the actual file" has to remain one click away.
 *
 * The fingerprint is what keeps this from going stale: `loadSource` and
 * `closeDocument` (in `state/actions.ts`) are the choke point for "a
 * different document is open now" -- resetting seven other per-document
 * stores -- but reaching back into this module from there would make the two
 * modules import each other (this one already imports `loadSource`).
 * Comparing fingerprints instead means `originalDocumentUrl` cleans itself up
 * on read: closing the document, opening an unrelated file, or a fetch that
 * resolves but never produces a loaded document (a 404, or a response that
 * fails to parse as a PDF) all change the live fingerprint without this
 * module needing to hear about any of them directly.
 */
let originalUrl: string | null = null;
let originalUrlFingerprint: string | null = null;

/** The URL the current document came from, or null if it wasn't opened from
 * one -- including if it once was, but a different document is open now. */
export function originalDocumentUrl(): string | null {
  const { info } = useDocumentStore.getState();
  return info && info.fingerprint === originalUrlFingerprint ? originalUrl : null;
}

/**
 * Download the document as the server sent it, bypassing anything Folio has
 * layered on top.
 *
 * Fetched into a blob rather than pointed at with `<a download>`: the download
 * attribute is ignored cross-origin, so the anchor would navigate instead, and
 * the extension's redirect rule would catch that navigation and land us back
 * in the viewer. `downloadBytes` (shared with Save a copy's browser path)
 * hands the bytes to the user from a same-origin blob URL instead, which has
 * no such problem. The refetch is normally served from cache.
 */
export async function downloadOriginal(): Promise<boolean> {
  const original = originalDocumentUrl();
  const url = original ? safeUrl(original) : null;
  if (!url) return false;
  try {
    const res = await fetch(url.href, { redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const filename = basename(url, res);
    downloadBytes(bytes, filename);
    announce(`Downloaded ${filename}`);
    return true;
  } catch {
    return false;
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
 * can link to the viewer with a fragment of its choosing. Before it reaches
 * `fetch`, `safeUrl` checks the scheme (keeping `javascript:`, `data:`, and
 * `file:` out -- `file:` is refused deliberately rather than by oversight,
 * since local PDFs are not handled yet and would need their own interception
 * path) and the host (keeping literal loopback/private/link-local/metadata
 * addresses out, the class of target the desktop app's `fetch_pdf` blocks by
 * resolving and pinning; see `isDisallowedHost` for what the browser can and
 * cannot do here). The fetch itself passes `redirect: 'error'`, so a target
 * that starts allowed and 3xx-bounces to one that is not gets refused rather
 * than followed.
 */
export async function openFromQueryParam(): Promise<void> {
  if (isTauri()) return;
  const raw = readFileParam();
  if (!raw) return;
  const url = safeUrl(raw);
  if (!url) return;
  try {
    const res = await fetch(url.href, { redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const source: DocumentSource = {
      kind: 'bytes',
      data: new Uint8Array(await res.arrayBuffer()),
      name: basename(url, res),
    };
    await loadSource(source);
    // loadSource swallows its own errors (an error state, not a throw), so
    // success is confirmed here rather than assumed: only a document that
    // actually finished loading gets associated with this URL.
    const { status, info } = useDocumentStore.getState();
    if (status === 'ready' && info) {
      originalUrl = url.href;
      originalUrlFingerprint = info.fingerprint;
    }
  } catch {
    // Leave the empty state; the user can still open a file manually.
  }
}
