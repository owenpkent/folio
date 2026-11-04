import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAnnotationStore } from '@/features/annotations/store';
import { useEditStore } from '@/features/editing/store';
import { useOcrStore } from '@/features/ocr/store';
import { remapPageState } from '@/features/pageops/pageState';
import { useSignatureStore } from '@/features/signatures/store';
import { useDocumentMutationStore } from '@/state/documentMutationStore';
import { useDocumentStore } from '@/state/documentStore';
import type { PdfDocumentInfo } from '@/core/pdf';

import { useLegacySidecarStore } from './legacyStore';

const NEW = 'sha256-of-this-file';
const OLD = 'pdfjs-fingerprint-shared-by-the-template';
const rect = { x: 0.4, y: 0.4, width: 0.2, height: 0.1 };
const sig = [
  { id: 'sig_1', pageNumber: 1, dataUrl: 'data:image/png;base64,AAAA', rect, createdAt: 1 },
];

/** Open `fingerprint` the way loadSource does: stores first, then detect. */
function open(fingerprint: string, legacyKey: string): void {
  useDocumentStore
    .getState()
    .setLoaded(
      { fingerprint, numPages: 1, name: 'a.pdf' } as PdfDocumentInfo,
      { pageCount: 1 },
      [],
    );
  useAnnotationStore.getState().loadForDocument(fingerprint);
  useSignatureStore.getState().loadForDocument(fingerprint);
  useEditStore.getState().loadForDocument(fingerprint);
  useOcrStore.getState().loadForDocument(fingerprint);
  useLegacySidecarStore.getState().detect(fingerprint, legacyKey);
}

const ocrPage = { 1: { pageNumber: 1, words: [] } };

beforeEach(() => {
  localStorage.clear();
  useLegacySidecarStore.getState().reset();
  useDocumentStore.getState().reset();
  useAnnotationStore.getState().reset();
  useSignatureStore.getState().reset();
  useEditStore.getState().reset();
  useOcrStore.getState().reset();
  useDocumentMutationStore.setState({ active: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Make every write to `key` fail the way a full localStorage does. */
function failWritesTo(key: string): void {
  const real = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k, v) {
    if (k === key) throw new DOMException('quota', 'QuotaExceededError');
    real.call(this, k, v);
  });
}

describe('legacy sidecar detection', () => {
  it('asks when a sidecar exists under the old key and nothing under the new one', () => {
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    open(NEW, OLD);
    expect(useLegacySidecarStore.getState().pending).toEqual({ fingerprint: NEW, legacyKey: OLD });
    // Nothing is applied until the user says so.
    expect(useSignatureStore.getState().signatures).toHaveLength(0);
  });

  it('stays quiet when there is no old state', () => {
    open(NEW, OLD);
    expect(useLegacySidecarStore.getState().pending).toBeNull();
  });

  it('ignores old entries that hold nothing', () => {
    localStorage.setItem(`folio.signatures.${OLD}`, '[]');
    localStorage.setItem(`folio.ocr.${OLD}`, '{}');
    localStorage.setItem(`folio.edits.${OLD}`, 'not json');
    open(NEW, OLD);
    expect(useLegacySidecarStore.getState().pending).toBeNull();
  });

  it('stays quiet once the file has state of its own under the new key', () => {
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    localStorage.setItem(`folio.annotations.${NEW}`, JSON.stringify([{ id: 'a' }]));
    open(NEW, OLD);
    expect(useLegacySidecarStore.getState().pending).toBeNull();
  });

  it('stays quiet when the content hash was unavailable and the keys coincide', () => {
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    open(OLD, OLD);
    expect(useLegacySidecarStore.getState().pending).toBeNull();
    // The stores loaded it directly, as before the fix.
    expect(useSignatureStore.getState().signatures).toHaveLength(1);
  });
});

describe('apply', () => {
  it('moves every sidecar under the new key, reloads the stores, and clears the old key', () => {
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    localStorage.setItem(`folio.ocr.${OLD}`, JSON.stringify({ 1: { pageNumber: 1, words: [] } }));
    open(NEW, OLD);

    useLegacySidecarStore.getState().apply();

    expect(useLegacySidecarStore.getState().pending).toBeNull();
    expect(useSignatureStore.getState().signatures).toHaveLength(1);
    expect(useOcrStore.getState().status).toBe('done');
    expect(localStorage.getItem(`folio.signatures.${NEW}`)).toContain('sig_1');
    expect(localStorage.getItem(`folio.signatures.${OLD}`)).toBeNull();
    expect(localStorage.getItem(`folio.ocr.${OLD}`)).toBeNull();
  });

  it('keeps work the user already did on this file over the inherited copy', () => {
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    open(NEW, OLD);
    // Placed before deciding: the banner is still up, but this is this file's own.
    useSignatureStore.getState().add(1, 'data:image/png;base64,BBBB', rect);

    useLegacySidecarStore.getState().apply();

    const { signatures } = useSignatureStore.getState();
    expect(signatures).toHaveLength(1);
    expect(signatures[0].dataUrl).toContain('BBBB');
    expect(localStorage.getItem(`folio.signatures.${OLD}`)).toBeNull();
  });

  it('is withdrawn, not carried over, when another document opens first', () => {
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    open(NEW, OLD);
    expect(useLegacySidecarStore.getState().pending).not.toBeNull();

    open('some-other-file', 'another-template');
    expect(useLegacySidecarStore.getState().pending).toBeNull();
    // The old entry is untouched: the first file can still claim it later.
    expect(localStorage.getItem(`folio.signatures.${OLD}`)).not.toBeNull();
  });

  it('copies over a destination that holds only an empty collection', () => {
    // A store that wrote its empty collection through (a page operation's
    // remap does this) is still "nothing here" to detect(), so apply has to
    // agree, or the offer deletes the old entry and restores nothing.
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    localStorage.setItem(`folio.signatures.${NEW}`, '[]');
    localStorage.setItem(`folio.ocr.${OLD}`, JSON.stringify(ocrPage));
    localStorage.setItem(`folio.ocr.${NEW}`, '{}');
    open(NEW, OLD);
    expect(useLegacySidecarStore.getState().pending).not.toBeNull();

    useLegacySidecarStore.getState().apply();

    expect(useSignatureStore.getState().signatures).toHaveLength(1);
    expect(useOcrStore.getState().status).toBe('done');
    expect(localStorage.getItem(`folio.signatures.${OLD}`)).toBeNull();
  });

  it('keeps every old entry, and puts back what it wrote, when a copy fails', () => {
    // Both copies have to coexist for a moment, so a nearly full localStorage
    // can refuse the second write after accepting the first.
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    localStorage.setItem(`folio.ocr.${OLD}`, JSON.stringify(ocrPage));
    open(NEW, OLD);
    failWritesTo(`folio.ocr.${NEW}`);

    useLegacySidecarStore.getState().apply();

    // Nothing lost: both old entries survive, the one copy that landed is
    // rolled back, and the offer stands so the user can retry or discard.
    expect(localStorage.getItem(`folio.signatures.${OLD}`)).toContain('sig_1');
    expect(localStorage.getItem(`folio.ocr.${OLD}`)).not.toBeNull();
    expect(localStorage.getItem(`folio.signatures.${NEW}`)).toBeNull();
    expect(localStorage.getItem(`folio.ocr.${NEW}`)).toBeNull();
    expect(useLegacySidecarStore.getState().pending).toEqual({ fingerprint: NEW, legacyKey: OLD });
    expect(useSignatureStore.getState().signatures).toHaveLength(0);

    // Once there is room again the same offer goes through.
    vi.restoreAllMocks();
    useLegacySidecarStore.getState().apply();
    expect(useSignatureStore.getState().signatures).toHaveLength(1);
    expect(localStorage.getItem(`folio.signatures.${OLD}`)).toBeNull();
  });

  it('is refused, with nothing touched, while a page operation holds the lock', () => {
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    open(NEW, OLD);
    // A page op has captured its undo snapshot (with no signatures in it)
    // and is waiting on the engine reload.
    const release = useDocumentMutationStore
      .getState()
      .acquire({ owner: 'pageops', scope: 'pages' });
    expect(release).not.toBeNull();

    useLegacySidecarStore.getState().apply();

    expect(localStorage.getItem(`folio.signatures.${OLD}`)).toContain('sig_1');
    expect(localStorage.getItem(`folio.signatures.${NEW}`)).toBeNull();
    expect(useSignatureStore.getState().signatures).toHaveLength(0);
    expect(useLegacySidecarStore.getState().pending).not.toBeNull();
    // The lock is still the page op's.
    expect(useDocumentMutationStore.getState().active.map((h) => h.owner)).toEqual(['pageops']);

    release?.();
    useLegacySidecarStore.getState().apply();
    expect(useSignatureStore.getState().signatures).toHaveLength(1);
    expect(useDocumentMutationStore.getState().active).toEqual([]);
  });

  it('is withdrawn, leaving the old entries, once a page operation changes the page map', () => {
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    open(NEW, OLD);
    // Rotating a page before deciding: the remap writes `[]` under the new
    // key, and the page op's undo snapshot would write it back over anything
    // applied afterwards.
    remapPageState(new Map([[1, 1]]), new Map([[1, 1]]));

    expect(useLegacySidecarStore.getState().pending).toBeNull();
    expect(localStorage.getItem(`folio.signatures.${OLD}`)).toContain('sig_1');
    expect(localStorage.getItem(`folio.signatures.${NEW}`)).toBe('[]');
    // Apply is now a no-op rather than a deletion.
    useLegacySidecarStore.getState().apply();
    expect(localStorage.getItem(`folio.signatures.${OLD}`)).toContain('sig_1');

    // Reopening the same file makes the offer again.
    open(NEW, OLD);
    expect(useLegacySidecarStore.getState().pending).toEqual({ fingerprint: NEW, legacyKey: OLD });
  });

  it('a second file from the same template opens clean after the first applied', () => {
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    open(NEW, OLD);
    useLegacySidecarStore.getState().apply();

    open('sha256-of-the-other-file', OLD);
    expect(useLegacySidecarStore.getState().pending).toBeNull();
    expect(useSignatureStore.getState().signatures).toHaveLength(0);
  });
});

describe('discard', () => {
  it('deletes the old entries and loads nothing', () => {
    localStorage.setItem(`folio.signatures.${OLD}`, JSON.stringify(sig));
    localStorage.setItem(`folio.annotations.${OLD}`, JSON.stringify([{ id: 'a' }]));
    open(NEW, OLD);

    useLegacySidecarStore.getState().discard();

    expect(useLegacySidecarStore.getState().pending).toBeNull();
    expect(useSignatureStore.getState().signatures).toHaveLength(0);
    expect(localStorage.getItem(`folio.signatures.${OLD}`)).toBeNull();
    expect(localStorage.getItem(`folio.annotations.${OLD}`)).toBeNull();
    expect(localStorage.getItem(`folio.signatures.${NEW}`)).toBeNull();
  });
});
