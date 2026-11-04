import { beforeEach, describe, expect, it } from 'vitest';

import { useAnnotationStore } from '@/features/annotations/store';
import { useEditStore } from '@/features/editing/store';
import { useOcrStore } from '@/features/ocr/store';
import { useSignatureStore } from '@/features/signatures/store';
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

beforeEach(() => {
  localStorage.clear();
  useLegacySidecarStore.getState().reset();
  useDocumentStore.getState().reset();
  useAnnotationStore.getState().reset();
  useSignatureStore.getState().reset();
  useEditStore.getState().reset();
  useOcrStore.getState().reset();
});

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
