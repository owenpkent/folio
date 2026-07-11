import { describe, expect, it } from 'vitest';

import { detectSignatures } from './verify';

describe('detectSignatures', () => {
  it('returns an empty array for an empty buffer', () => {
    expect(detectSignatures(new Uint8Array())).toEqual([]);
  });

  it('returns an empty array for a PDF with no signatures', () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF');
    expect(detectSignatures(bytes)).toEqual([]);
  });
});
