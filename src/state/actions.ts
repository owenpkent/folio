import { pickAndReadDocument } from '@/core/document/openDocument';
import { getEngine, type DocumentSource } from '@/core/pdf';
import { announce } from '@/a11y/announcer';
import { useAnnotationStore } from '@/features/annotations';
import { useSignatureStore } from '@/features/signatures';
import { detectSignatures, useSigningStore } from '@/features/signing';
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
    viewer.reset();
    viewer.setNumPages(info.numPages);
    useAnnotationStore.getState().loadForDocument(info.fingerprint);
    useSignatureStore.getState().loadForDocument(info.fingerprint);
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
  useSigningStore.getState().setDetected([]);
  document.title = 'Folio';
  announce('Closed document');
}
