import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { zipSync } from './zip.mjs';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Parse an archive back into `{ name: Buffer }` by walking the central
 * directory, the way a real extractor does. Written independently of zipSync so
 * a bug in the writer cannot cancel itself out in the reader.
 */
function unzip(buf) {
  const eocd = buf.length - 22;
  if (buf.readUInt32LE(eocd) !== SIG_EOCD) throw new Error('no end-of-central-directory');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);

  const out = {};
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== SIG_CENTRAL) throw new Error(`bad central header at entry ${i}`);
    const method = buf.readUInt16LE(at + 10);
    const compSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);

    if (buf.readUInt32LE(localAt) !== SIG_LOCAL) throw new Error(`bad local header for ${name}`);
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(dataAt, dataAt + compSize);

    out[name] = method === 0 ? Buffer.from(body) : inflateRawSync(body);
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

const COMPRESSIBLE = Buffer.from('folio '.repeat(500));
// Seeded xorshift, so the bytes are noise-like but the test never flakes.
// A plain arithmetic sequence will not do: `(i * k) % 256` is linear, and
// deflate compresses it happily, which is not what this fixture is for.
const INCOMPRESSIBLE = (() => {
  let s = 0x12345678;
  return Buffer.from(
    Array.from({ length: 4096 }, () => {
      s ^= (s << 13) >>> 0;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= (s << 5) >>> 0;
      s >>>= 0;
      return s & 0xff;
    }),
  );
})();

describe('zipSync', () => {
  it('round-trips file contents', () => {
    const entries = [
      { name: 'manifest.json', data: Buffer.from('{"a":1}') },
      { name: 'dist/index.html', data: COMPRESSIBLE },
      { name: 'icons/icon-16.png', data: INCOMPRESSIBLE },
    ];
    const back = unzip(zipSync(entries));

    expect(Object.keys(back).sort()).toEqual(['dist/index.html', 'icons/icon-16.png', 'manifest.json']);
    for (const { name, data } of entries) {
      expect(back[name].equals(data)).toBe(true);
    }
  });

  it('produces identical bytes for identical input', () => {
    const entries = [{ name: 'a.txt', data: COMPRESSIBLE }, { name: 'b.txt', data: Buffer.from('b') }];
    expect(zipSync(entries).equals(zipSync(entries))).toBe(true);
  });

  it('does not depend on the order entries are handed in', () => {
    // Directory walk order varies by filesystem; the package must not.
    const a = { name: 'a.txt', data: Buffer.from('a') };
    const b = { name: 'b.txt', data: Buffer.from('b') };
    expect(zipSync([a, b]).equals(zipSync([b, a]))).toBe(true);
  });

  it('stores rather than deflates when deflating would grow the file', () => {
    // Already-compressed payloads (PNGs, the gzipped OCR model) inflate under
    // deflate; storing them keeps the package smaller.
    const zipped = zipSync([{ name: 'x.bin', data: INCOMPRESSIBLE }]);
    expect(zipped.readUInt16LE(8)).toBe(0); // local header method == store
    expect(unzip(zipped)['x.bin'].equals(INCOMPRESSIBLE)).toBe(true);
  });

  it('normalizes Windows path separators', () => {
    // The format mandates forward slashes; Windows path joins do not give them.
    const back = unzip(zipSync([{ name: 'dist\\assets\\app.js', data: Buffer.from('x') }]));
    expect(Object.keys(back)).toEqual(['dist/assets/app.js']);
  });

  it('handles an empty archive', () => {
    expect(Object.keys(unzip(zipSync([])))).toEqual([]);
  });
});
