import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PdfCore from '@/core/pdf';
import { useAnnotationStore } from '@/features/annotations/store';
import { useLegacySidecarStore } from '@/features/sidecar/legacyStore';
import { useSignatureStore } from '@/features/signatures/store';

// A stand-in engine that behaves like PDF.js in the two ways that matter here:
// it reports one fingerprint for every file made from the same template, and
// it takes the bytes with it (PDF.js transfers the array to its worker and
// detaches the caller's view), so anything that needs them has to run first.
const SHARED_FINGERPRINT = 'same-template-same-id';
vi.mock('@/core/pdf', async (orig) => {
  const actual = (await orig()) as typeof PdfCore;
  return {
    ...actual,
    getEngine: () => ({
      loadDocument: async (source: PdfCore.DocumentSource) => {
        if (source.kind === 'bytes')
          structuredClone(source.data, { transfer: [source.data.buffer] });
        return { numPages: 1, fingerprint: SHARED_FINGERPRINT, name: source.name ?? 'x.pdf' };
      },
      getMetadata: async () => ({ pageCount: 1 }),
      getOutline: async () => [],
      closeDocument: async () => {},
    }),
  };
});
vi.mock('@/a11y/announcer', () => ({ announce: vi.fn() }));

import { useDocumentStore } from './documentStore';
import { closeDocument, loadSource } from './actions';

const rect = { x: 0.4, y: 0.4, width: 0.2, height: 0.1 };
const pdf = (body: string) => new TextEncoder().encode(`%PDF-1.7\n${body}\ntrailer<</ID[<a><a>]>>`);

beforeEach(async () => {
  localStorage.clear();
  await closeDocument();
});

describe('sidecar key on open', () => {
  it('gives two files with the same engine fingerprint different keys', async () => {
    await loadSource({ kind: 'bytes', data: pdf('Alice'), name: 'alice.pdf' });
    const alice = useDocumentStore.getState().info!.fingerprint;
    await loadSource({ kind: 'bytes', data: pdf('Bob'), name: 'bob.pdf' });
    const bob = useDocumentStore.getState().info!.fingerprint;

    expect(alice).toMatch(/^[0-9a-f]{64}$/);
    expect(bob).toMatch(/^[0-9a-f]{64}$/);
    expect(alice).not.toBe(bob);
    expect(alice).not.toBe(SHARED_FINGERPRINT);
  });

  it('keeps a signature placed on one file off another file from the same form', async () => {
    await loadSource({ kind: 'bytes', data: pdf('Alice'), name: 'alice.pdf' });
    useSignatureStore.getState().add(1, 'data:image/png;base64,AAAA', rect);

    await loadSource({ kind: 'bytes', data: pdf('Bob'), name: 'bob.pdf' });
    expect(useSignatureStore.getState().signatures).toHaveLength(0);
    expect(useLegacySidecarStore.getState().pending).toBeNull();

    await loadSource({ kind: 'bytes', data: pdf('Alice'), name: 'alice.pdf' });
    expect(useSignatureStore.getState().signatures).toHaveLength(1);
  });

  it('offers state saved under the old key once, and only to a file with none of its own', async () => {
    // Saved by a Folio before the content key existed.
    localStorage.setItem(
      `folio.annotations.${SHARED_FINGERPRINT}`,
      JSON.stringify([{ id: 'ann_1', pageNumber: 1, kind: 'highlight' }]),
    );
    await loadSource({ kind: 'bytes', data: pdf('Alice'), name: 'alice.pdf' });
    expect(useAnnotationStore.getState().annotations).toHaveLength(0);
    expect(useLegacySidecarStore.getState().pending?.legacyKey).toBe(SHARED_FINGERPRINT);

    useLegacySidecarStore.getState().apply();
    expect(useAnnotationStore.getState().annotations).toHaveLength(1);

    await loadSource({ kind: 'bytes', data: pdf('Bob'), name: 'bob.pdf' });
    expect(useAnnotationStore.getState().annotations).toHaveLength(0);
    expect(useLegacySidecarStore.getState().pending).toBeNull();
  });

  it('closing the document withdraws the offer', async () => {
    localStorage.setItem(`folio.signatures.${SHARED_FINGERPRINT}`, JSON.stringify([{ id: 's' }]));
    await loadSource({ kind: 'bytes', data: pdf('Alice'), name: 'alice.pdf' });
    expect(useLegacySidecarStore.getState().pending).not.toBeNull();
    await closeDocument();
    expect(useLegacySidecarStore.getState().pending).toBeNull();
  });
});
