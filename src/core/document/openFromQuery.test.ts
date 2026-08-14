import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PdfDocumentInfo } from '@/core/pdf';
import { useDocumentStore } from '@/state/documentStore';

vi.mock('./openDocument', () => ({ isTauri: () => false }));

const loadSource = vi.hoisted(() => vi.fn());
vi.mock('@/state/actions', () => ({ loadSource }));

// downloadOriginal's real implementation reaches document.createElement /
// URL.createObjectURL by way of this; mocked so the success path is
// testable without depending on jsdom's Blob/URL support, and so the call
// arguments (the actual point of the tests below) are directly assertable.
const downloadBytes = vi.hoisted(() => vi.fn());
vi.mock('./downloadBytes', () => ({ downloadBytes }));

import { downloadOriginal, openFromQueryParam, originalDocumentUrl } from './openFromQuery';

/** Point `window.location` at a viewer URL carrying `hash`. */
function withHash(hash: string): void {
  window.history.replaceState(null, '', `/${hash}`);
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

/** A fingerprint distinct enough from any other test's to catch a stale
 * comparison. */
function markReady(fingerprint = `fp-${Math.random()}`): void {
  useDocumentStore.setState({
    status: 'ready',
    info: { fingerprint } as PdfDocumentInfo,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  useDocumentStore.setState({ status: 'empty', info: null });
  loadSource.mockReset();
  downloadBytes.mockReset();
  // The default double for every real loadSource call this suite makes: a
  // document that actually finished loading. Tests exercising a load that
  // never becomes ready (a 404, a non-PDF response) never call loadSource in
  // the first place, so they do not need to override this.
  loadSource.mockImplementation(async () => {
    markReady();
  });
});

afterEach(() => {
  withHash('');
});

describe('openFromQueryParam', () => {
  it('keeps a query string intact instead of truncating at the first &', async () => {
    // The regression that motivated reading the fragment verbatim: parsing it
    // as a query string ends the URL at `&fmt=pdf` and fetches the wrong doc.
    const url = 'https://example.com/download?doc=42&fmt=pdf';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(PDF_BYTES, { status: 200 }));

    withHash(`#file=${url}`);
    await openFromQueryParam();

    expect(fetchSpy).toHaveBeenCalledWith(url, { redirect: 'error' });
    expect(originalDocumentUrl()).toBe(url);
  });

  it('decodes the ?file= form, which is encoded', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(PDF_BYTES, { status: 200 }));

    window.history.replaceState(null, '', `/?file=${encodeURIComponent('https://example.com/a.pdf')}`);
    await openFromQueryParam();

    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/a.pdf', { redirect: 'error' });
  });

  it('refuses schemes it will not fetch', async () => {
    // The fragment comes from a page navigation, so any site can choose it.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    for (const hostile of ['javascript:alert(1)', 'data:application/pdf;base64,AA==', 'file:///c:/a.pdf']) {
      withHash(`#file=${hostile}`);
      await openFromQueryParam();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadSource).not.toHaveBeenCalled();
  });

  it('refuses loopback, private, link-local, and metadata hosts', async () => {
    // A hostile page can navigate here with any fragment it likes; the
    // extension's host permissions make the fetch CORS-exempt, so this is the
    // browser-side counterpart to the desktop `fetch_pdf` SSRF guard.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const hostile = [
      'http://127.0.0.1/secret',
      'http://127.0.0.1:8080/secret', // a port does not change the host check
      'http://[::1]/secret',
      'http://localhost/secret',
      'http://sub.localhost/secret',
      'http://10.0.0.5/internal',
      'http://172.16.0.1/internal',
      'http://192.168.1.1/internal',
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://[fe80::1]/internal', // link-local IPv6
      'http://[::ffff:127.0.0.1]/secret', // IPv4-mapped IPv6 loopback
      'http://foo.local/internal', // mDNS
      'http://0/secret', // 0.0.0.0
      'http://0177.0.0.1/secret', // octal-encoded loopback; URL normalizes this to 127.0.0.1
    ];
    for (const url of hostile) {
      withHash(`#file=${url}`);
      await openFromQueryParam();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadSource).not.toHaveBeenCalled();
  });

  it('still allows an ordinary public host', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(PDF_BYTES, { status: 200 }));

    withHash('#file=https://example.com/a.pdf');
    await openFromQueryParam();

    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/a.pdf', { redirect: 'error' });
  });

  it('does nothing without a file parameter', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    withHash('#page=3');
    await openFromQueryParam();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves the empty state alone when the fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }));
    withHash('#file=https://example.com/missing.pdf');
    await openFromQueryParam();
    expect(loadSource).not.toHaveBeenCalled();
    // Nothing in this module gets told a document opened and closed elsewhere
    // (loadSource/closeDocument, in state/actions.ts, own that); querying
    // against the still-empty store is what keeps a failed fetch from
    // leaving a stale URL behind.
    expect(originalDocumentUrl()).toBeNull();
  });

  it('does not associate the URL with a document that fetched fine but never finished loading', async () => {
    // loadSource swallows its own errors (an error state, not a throw) --
    // e.g. the response was a 200 that is not actually a parseable PDF.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(PDF_BYTES, { status: 200 }));
    loadSource.mockImplementation(async () => {
      useDocumentStore.setState({ status: 'error', info: null });
    });

    withHash('#file=https://example.com/a.pdf');
    await openFromQueryParam();

    expect(originalDocumentUrl()).toBeNull();
  });

  it('forgets the URL once a different document is open', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(PDF_BYTES, { status: 200 }));
    withHash('#file=https://example.com/a.pdf');
    await openFromQueryParam();
    expect(originalDocumentUrl()).toBe('https://example.com/a.pdf');

    // Stands in for opening an unrelated local file, or closing the document:
    // either changes the store's fingerprint (or clears it) without this
    // module hearing about it directly.
    markReady('a-completely-different-document');
    expect(originalDocumentUrl()).toBeNull();

    useDocumentStore.setState({ status: 'empty', info: null });
    expect(originalDocumentUrl()).toBeNull();
  });
});

describe('basename (via the DocumentSource handed to loadSource)', () => {
  function loadedName(): string {
    const calls = loadSource.mock.calls;
    const source = calls[calls.length - 1]?.[0] as { name: string };
    return source.name;
  }

  it('prefers Content-Disposition over the URL path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(PDF_BYTES, {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="Quarterly Report.pdf"' },
      }),
    );
    withHash('#file=https://example.com/download?doc=42&fmt=pdf');
    await openFromQueryParam();
    expect(loadedName()).toBe('Quarterly Report.pdf');
  });

  it('decodes an RFC 5987 filename*', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(PDF_BYTES, {
        status: 200,
        headers: { 'content-disposition': "attachment; filename*=UTF-8''report%20%C3%A9.pdf" },
      }),
    );
    withHash('#file=https://example.com/download?doc=42');
    await openFromQueryParam();
    expect(loadedName()).toBe('report é.pdf');
  });

  it('appends .pdf when the path has no extension and the response says it is one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(PDF_BYTES, { status: 200, headers: { 'content-type': 'application/pdf; charset=binary' } }),
    );
    // This PR's own headline URL shape: no filename in the path at all.
    withHash('#file=https://example.com/download?doc=42&fmt=pdf');
    await openFromQueryParam();
    expect(loadedName()).toBe('download.pdf');
  });

  it('leaves an extension-less name alone without a PDF content-type to justify one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(PDF_BYTES, { status: 200 }));
    withHash('#file=https://example.com/api/v1/documents/42');
    await openFromQueryParam();
    expect(loadedName()).toBe('42');
  });

  it('keeps an existing extension untouched', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(PDF_BYTES, { status: 200 }));
    withHash('#file=https://example.com/a.pdf');
    await openFromQueryParam();
    expect(loadedName()).toBe('a.pdf');
  });
});

describe('downloadOriginal', () => {
  it('reports failure rather than throwing when the refetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(PDF_BYTES, { status: 200 }));
    withHash('#file=https://example.com/a.pdf');
    await openFromQueryParam();

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(downloadOriginal()).resolves.toBe(false);
  });

  it('hands the refetched bytes to the shared download helper and reports success', async () => {
    // A fresh Response per call: openFromQueryParam and downloadOriginal each
    // consume a body, and a Response's body can only be read once.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(PDF_BYTES, { status: 200 }));
    withHash('#file=https://example.com/a.pdf');
    await openFromQueryParam();

    await expect(downloadOriginal()).resolves.toBe(true);
    expect(downloadBytes).toHaveBeenCalledTimes(1);
    const [bytes, filename] = downloadBytes.mock.calls[0];
    expect(new Uint8Array(bytes)).toEqual(PDF_BYTES);
    expect(filename).toBe('a.pdf');
  });

  it('does nothing once the URL no longer matches the open document', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(PDF_BYTES, { status: 200 }));
    withHash('#file=https://example.com/a.pdf');
    await openFromQueryParam();

    markReady('a-different-document');
    await expect(downloadOriginal()).resolves.toBe(false);
    // Exactly the one call the setup above made, and none from downloadOriginal.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(downloadBytes).not.toHaveBeenCalled();
  });
});
