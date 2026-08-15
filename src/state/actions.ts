import { pickAndReadDocument, type BytesDocumentSource } from '@/core/document/openDocument';
import { getEngine, type DocumentSource } from '@/core/pdf';
import { resetPageSizes } from '@/core/pdf/pageSizes';
import { announce } from '@/a11y/announcer';
import { useAnnotationStore } from '@/features/annotations';
// Store only, not the feature barrel: that also exports CombineModal, which
// pulls in UI modules this low-level orchestration module has no business
// importing (same reason placement and textedit are imported this way below).
import { useCombineStore } from '@/features/combine/store';
import { useEditStore } from '@/features/editing';
// Store only, not the feature barrel: it also exports AddressHint and
// useTrackAddressHover, UI modules this low-level orchestration module has no
// business importing.
import { useAddressHover } from '@/features/links/store';
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

import { useDocumentMutationStore } from './documentMutationStore';
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

/**
 * Route one or more freshly read PDFs the same way regardless of where they
 * came from: a single file opens normally, two or more open (or extend) the
 * combine modal. This is the one dispatch point for that decision -- the
 * Tauri native drag-drop listener (`App.tsx`) and the browser/extension HTML5
 * drop target (`EmptyState.tsx`) both call it rather than each re-implementing
 * the branch, so they cannot drift out of sync with each other again.
 *
 * Dropping more files while the combine modal is already open adds to the
 * staged list instead of replacing it: `open()` resets `busy` and wipes
 * whatever was already staged, which would also cut off a merge in progress.
 */
export async function openDroppedPdfs(sources: BytesDocumentSource[]): Promise<void> {
  if (sources.length === 0) return;
  if (sources.length === 1) {
    await loadSource(sources[0]);
    return;
  }
  const seed = sources.map((s) => ({ name: s.name ?? 'Untitled.pdf', bytes: s.data }));
  const combine = useCombineStore.getState();
  if (combine.modalOpen) {
    combine.addFiles(seed);
  } else {
    combine.open(seed);
  }
}

export async function loadSource(source: DocumentSource): Promise<void> {
  const engine = getEngine();
  const doc = useDocumentStore.getState();
  const viewer = useViewerStore.getState();

  // Only acquire the cross-feature lock if nobody already holds it: combine
  // calls this at the end of its own already-locked run (see runCombine in
  // features/combine/commands.ts), and releasing the lock here, before
  // combine's own cleanup after this call has run, would let something else
  // start while combine is still finishing up. Every other caller (Open, a
  // dropped file, a deep link, a launch file) reaches this with the lock
  // free, so it owns it for the duration of this load.
  const mutation = useDocumentMutationStore.getState();
  const ownsLock = !mutation.inFlight;
  if (ownsLock) mutation.begin();

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
    // Also not persisted: a hint resolved against the previous document's page
    // geometry must not survive into this one.
    useAddressHover.getState().clear();
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
  } finally {
    // Unconditional: a load that threw still has to release a lock this
    // function acquired, or every other mutating entry point stays disabled
    // forever over one failed open.
    if (ownsLock) mutation.end();
  }
}

export async function closeDocument(): Promise<void> {
  // Closing replaces the engine's document with nothing, exactly the kind of
  // change a mid-flight page op / text edit / image edit could be reloading
  // on top of; see documentMutationStore.ts. This command has a single call
  // site (defaultCommands.ts), so unlike loadSource it never has to worry
  // about nesting inside another already-locked operation.
  const mutation = useDocumentMutationStore.getState();
  if (mutation.inFlight) return;
  mutation.begin();
  try {
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
    useAddressHover.getState().clear();
    useSigningStore.getState().setDetected([]);
    document.title = 'Folio';
    announce('Closed document');
  } finally {
    mutation.end();
  }
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
  const info = await engine.loadDocument({ kind: 'bytes', data: bytes, name: doc.info.name });
  useDocumentStore.getState().bumpDocVersion();
  // Pages repaint in place on a docVersion bump (Page.tsx re-runs its canvas /
  // text-layer / annotation-layer effects rather than remounting), so scroll
  // position is never disturbed and needs no explicit preservation here.

  // Page operations are the only feature that can change the page count, but
  // nothing else here refreshes it: without this, info.numPages keeps the
  // open-time count and anything that loops over "every page" (the Word Count
  // plugin, ai/documentText.ts) runs past the end of a document that just
  // lost pages. The fingerprint is deliberately left alone -- see the doc
  // comment above.
  useDocumentStore.getState().setNumPages(info.numPages);

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
