import { pickAndReadDocument } from '@/core/document/openDocument';
import { getEngine, type DocumentSource } from '@/core/pdf';
import { announce } from '@/a11y/announcer';
import { useAnnotationStore } from '@/features/annotations';
import { useEditStore } from '@/features/editing';
import { useOcrStore } from '@/features/ocr';
// Store only, not the feature barrel: that also exports components, which pull
// in UI modules this low-level orchestration module has no business importing.
import { usePlacementStore } from '@/features/placement/store';
import { useSignatureStore } from '@/features/signatures';
import { detectSignatures, useSigningStore } from '@/features/signing';
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
    const info = await engine.loadDocument(source);
    const [metadata, outline] = await Promise.all([engine.getMetadata(), engine.getOutline()]);

    doc.setLoaded(info, metadata, outline);
    doc.setSourcePath(source.kind === 'bytes' ? (source.path ?? null) : null);
    viewer.reset();
    viewer.setNumPages(info.numPages);
    useAnnotationStore.getState().loadForDocument(info.fingerprint);
    useSignatureStore.getState().loadForDocument(info.fingerprint);
    useEditStore.getState().loadForDocument(info.fingerprint);
    useOcrStore.getState().loadForDocument(info.fingerprint);
    // Not persisted (nothing to load per fingerprint), but a fresh document is
    // never mid-edit, so any leftover session/undo history from a prior one goes.
    useTextEditStore.getState().reset();
    usePlacementStore.getState().cancel();
    try {
      const original = engine.getOriginalBytes();
      useSigningStore.getState().setDetected(original ? detectSignatures(original) : []);
    } catch {
      useSigningStore.getState().setDetected([]);
    }
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
  useDocumentStore.getState().reset();
  useViewerStore.getState().reset();
  useAnnotationStore.getState().reset();
  useSignatureStore.getState().reset();
  useEditStore.getState().reset();
  useOcrStore.getState().reset();
  useTextEditStore.getState().reset();
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
  await engine.loadDocument({ kind: 'bytes', data: bytes, name: doc.info.name });
  useDocumentStore.getState().bumpDocVersion();
  // Pages repaint in place on a docVersion bump (Page.tsx re-runs its canvas /
  // text-layer / annotation-layer effects rather than remounting), so scroll
  // position is never disturbed and needs no explicit preservation here.

  try {
    const original = engine.getOriginalBytes();
    useSigningStore.getState().setDetected(original ? detectSignatures(original) : []);
  } catch {
    useSigningStore.getState().setDetected([]);
  }
}
