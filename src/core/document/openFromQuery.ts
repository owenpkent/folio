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

function basename(url: URL): string {
  try {
    const last = decodeURIComponent(url.pathname.split('/').pop() || '');
    // Decoding can reintroduce separators that were percent-encoded in the
    // path (`/a%2Fb.pdf`), and this feeds an `<a download>`. Browsers sanitize
    // that attribute themselves, but a filename is not the place to rely on it.
    return last.replace(/[\\/]/g, '_').replace(/^\.+/, '') || 'Document.pdf';
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
/**
 * The URL this document was fetched from, when it arrived via `#file=`.
 *
 * Held so the viewer can offer the original back to the user. The browser
 * extension redirects PDF navigations here, including ones the site meant as a
 * download, so "give me the actual file" has to remain one click away.
 */
let originalUrl: string | null = null;

/** The URL the current document came from, or null if it wasn't opened from one. */
export function originalDocumentUrl(): string | null {
  return originalUrl;
}

/**
 * Download the document as the server sent it, bypassing anything Folio has
 * layered on top.
 *
 * Fetched into a blob rather than pointed at with `<a download>`: the download
 * attribute is ignored cross-origin, so the anchor would navigate instead, and
 * the extension's redirect rule would catch that navigation and land us back in
 * the viewer. A same-origin blob URL has no such problem. The refetch is
 * normally served from cache.
 */
export async function downloadOriginal(): Promise<boolean> {
  const url = originalUrl ? safeUrl(originalUrl) : null;
  if (!url) return false;
  let objectUrl: string | null = null;
  try {
    const res = await fetch(url.href, { redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    objectUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = basename(url);
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    return true;
  } catch {
    return false;
  } finally {
    // Revoking immediately can cancel the download in some browsers; give the
    // click a turn of the event loop to be picked up first.
    if (objectUrl) {
      const toRevoke = objectUrl;
      setTimeout(() => URL.revokeObjectURL(toRevoke), 60_000);
    }
  }
}

export async function openFromQueryParam(): Promise<void> {
  if (isTauri()) return;
  const raw = readFileParam();
  if (!raw) return;
  const url = safeUrl(raw);
  if (!url) return;
  // Recorded before the load so anything reacting to the document appearing
  // already sees a URL to offer back.
  originalUrl = url.href;
  try {
    const res = await fetch(url.href, { redirect: 'error' });
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
