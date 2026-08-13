import { pickAndReadDocument } from '@/core/document/openDocument';
import { getEngine, type DocumentSource } from '@/core/pdf';
import { resetPageSizes } from '@/core/pdf/pageSizes';
import { announce } from '@/a11y/announcer';
import { useAnnotationStore } from '@/features/annotations';
import { useEditStore } from '@/features/editing';
import { useOcrStore } from '@/features/ocr';
// Store only, not the feature barrel: that also exports components, which pull
// in UI modules this low-level orchestration module has no business importing.
import { usePageOpsStore } from '@/features/pageops/store';
import { usePlacementStore } from '@/features/placement/store';
import { useSignatureStore } from '@/features/signatures';
import { detectSignatures, useSigningStore, type DetectedSignature } from '@/features/signing';
// Import the store directly rather than the feature barrel: the barrel also
// exports TextEditLayer, which imports reloadEditedBytes from this file, and
// routing through it here would make that a circular module dependency.
import { useTextEditStore } from '@/features/textedit/store';
import { pluginHost } from '@/plugins/PluginHost';

import { useDocumentStore } from './documentStore';
import { useViewerStore } from './viewerStore';

/**
 * High-level orchestration that ties the engine, the stores, accessibility
 * announcements, and the plugin host together. UI and commands call these
 * rather than poking the engine directly.
 */

export async function openDocumentViaPicker(): Promise<void> {
  const source = await pickAndReadDocument();
  if (source) await loadSource(source);
}

export async function loadSource(source: DocumentSource): Promise<void> {
  const engine = getEngine();
  const doc = useDocumentStore.getState();
  const viewer = useViewerStore.getState();

  doc.setStatus('loading');
  try {
    // Before loadDocument, not after: pdf.js transfers the byte array to its
    // worker and detaches this view, so these are the last bytes anyone on the
    // main thread can read. The engine used to keep a private copy for exactly
    // this, which meant a second copy of the whole file resident for the whole
    // session to serve one caller that wanted three fields out of it.
    const detected = detectSignaturesSafely(source);
    const info = await engine.loadDocument(source);
    const [metadata, outline] = await Promise.all([engine.getMetadata(), engine.getOutline()]);

    doc.setLoaded(info, metadata, outline);
    doc.setSourcePath(source.kind === 'bytes' ? (source.path ?? null) : null);
    // Page sizes are per document; a stale estimate would lay the new one out
    // at the old one's page size until each page measured itself.
    resetPageSizes();
    viewer.reset();
    viewer.setNumPages(info.numPages);
    useAnnotationStore.getState().loadForDocument(info.fingerprint);
    useSignatureStore.getState().loadForDocument(info.fingerprint);
    useEditStore.getState().loadForDocument(info.fingerprint);
    useOcrStore.getState().loadForDocument(info.fingerprint);
    // Not persisted (nothing to load per fingerprint), but a fresh document is
    // never mid-edit, so any leftover session/undo history from a prior one goes.
    useTextEditStore.getState().reset();
    // Same again for page ops: a selection and an undo stack of the last
    // document's bytes mean nothing here, and restoring one would be a disaster.
    usePageOpsStore.getState().reset();
    usePlacementStore.getState().cancel();
    useSigningStore.getState().setDetected(detected);
    document.title = `${info.name} · Folio`;

    pluginHost.emitDocumentOpen({
      name: info.name,
      numPages: info.numPages,
      fingerprint: info.fingerprint,
    });
    announce(`Opened ${info.name}, ${info.numPages} page${info.numPages === 1 ? '' : 's'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to open document';
    doc.setError(message);
    announce(`Could not open document: ${message}`, true);
  }
}

export async function closeDocument(): Promise<void> {
  await getEngine().closeDocument();
  resetPageSizes();
  useDocumentStore.getState().reset();
  useViewerStore.getState().reset();
  useAnnotationStore.getState().reset();
  useSignatureStore.getState().reset();
  useEditStore.getState().reset();
  useOcrStore.getState().reset();
  useTextEditStore.getState().reset();
  usePageOpsStore.getState().reset();
  usePlacementStore.getState().cancel();
  useSigningStore.getState().setDetected([]);
  document.title = 'Folio';
  announce('Closed document');
}

/**
 * Swap the engine's document for freshly edited bytes (in-place text edits),
 * without resetting any per-feature store or changing the stored fingerprint:
 * unlike {@link loadSource}, this is still the same logical document, just
 * with new bytes, so per-fingerprint state (placed edits, signatures, OCR
 * text, annotations) must survive the reload untouched.
 */
export async function reloadEditedBytes(bytes: Uint8Array): Promise<void> {
  const doc = useDocumentStore.getState();
  if (doc.status !== 'ready' || !doc.info) return;

  const engine = getEngine();
  // Same ordering rule as loadSource: read the bytes before the engine takes
  // (and detaches) them. Callers must not touch `bytes` after this returns.
  const detected = detectSignaturesSafely({ kind: 'bytes', data: bytes });
  await engine.loadDocument({ kind: 'bytes', data: bytes, name: doc.info.name });
  useDocumentStore.getState().bumpDocVersion();
  // Pages repaint in place on a docVersion bump (Page.tsx re-runs its canvas /
  // text-layer / annotation-layer effects rather than remounting), so scroll
  // position is never disturbed and needs no explicit preservation here.

  useSigningStore.getState().setDetected(detected);
}

/**
 * Scan a source's bytes for signatures, never throwing.
 *
 * A malformed or hostile document must not stop the open: signature detection
 * is advisory, so a failure means "none found", not "cannot show this file".
 */
function detectSignaturesSafely(source: DocumentSource): DetectedSignature[] {
  if (source.kind !== 'bytes') return [];
  try {
    return detectSignatures(source.data);
  } catch {
    return [];
  }
}
