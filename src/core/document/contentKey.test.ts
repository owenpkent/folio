import { describe, expect, it } from 'vitest';

import { contentKey } from './contentKey';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('contentKey', () => {
  it('is the SHA-256 of the bytes, hex-encoded', async () => {
    // echo -n "abc" | sha256sum
    await expect(contentKey({ kind: 'bytes', data: bytes('abc') })).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes only the view, not the whole underlying buffer', async () => {
    const backing = bytes('xxabcyy');
    const view = backing.subarray(2, 5);
    await expect(contentKey({ kind: 'bytes', data: view })).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('tells two files apart even when they share a header and a trailer /ID', async () => {
    // Same first kilobyte and same /ID: PDF.js gives these one fingerprint.
    const header = '%PDF-1.7\n'.padEnd(1024, ' ');
    const trailer = 'trailer << /ID [<abc> <abc>] >>';
    const a = bytes(`${header}Alice${trailer}`);
    const b = bytes(`${header}Bob${trailer}`);
    const [ka, kb] = await Promise.all([
      contentKey({ kind: 'bytes', data: a }),
      contentKey({ kind: 'bytes', data: b }),
    ]);
    expect(ka).not.toBe(kb);
  });

  it('has nothing to hash for a url source', async () => {
    await expect(
      contentKey({ kind: 'url', url: 'https://example.test/a.pdf' }),
    ).resolves.toBeNull();
  });
});
