import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./openDocument', () => ({ isTauri: () => false }));

const loadSource = vi.hoisted(() => vi.fn());
vi.mock('@/state/actions', () => ({ loadSource }));

import { downloadOriginal, openFromQueryParam, originalDocumentUrl } from './openFromQuery';

/** Point `window.location` at a viewer URL carrying `hash`. */
function withHash(hash: string): void {
  window.history.replaceState(null, '', `/${hash}`);
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

beforeEach(() => {
  loadSource.mockClear();
  vi.restoreAllMocks();
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
});
