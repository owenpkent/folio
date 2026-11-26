import { contentKey } from '@/core/document/contentKey';
import { pickAndReadDocument, type BytesDocumentSource } from '@/core/document/openDocument';
import { getEngine, type DocumentSource } from '@/core/pdf';
import { resetPageSizes } from '@/core/pdf/pageSizes';
import { announce } from '@/a11y/announcer';
// The toast store only, not the components barrel: that also exports Button,
// ToastHost, and the rest of the UI kit, which this low-level orchestration
// module has no business importing (same rule as the feature imports below).
import { pushToast } from '@/components/common/toastStore';
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
import {
  findPosition,
  positionKeys,
  setReadingPosition,
  type PositionKeys,
  startReadingPosition,
  stopReadingPosition,
} from '@/features/readingPosition';
import { useImageEditStore } from '@/features/imageedit/store';
// Store only, not the feature barrel: that also exports the banner component.
import { useLegacySidecarStore } from '@/features/sidecar/legacyStore';
import { useSignatureStore } from '@/features/signatures';
import { detectSignatures, useSigningStore, type DetectedSignature } from '@/features/signing';
// Import the store directly rather than the feature barrel: the barrel also
// exports TextEditLayer, which imports reloadEditedBytes from this file, and
// routing through it here would make that a circular module dependency.
import { useTextEditStore } from '@/features/textedit/store';
import { pluginHost } from '@/plugins/PluginHost';

import {
  assertDocumentMutationHeld,
  DOCUMENT_MUTATION_BUSY_TITLE,
  withDocumentMutation,
} from './documentMutationStore';
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
 * That check comes before the single-file branch, not after it, because a
 * lone dropped PDF is the case that used to slip past: the drop listener is a
 * window-level one that the modal's focus trap does nothing about, so one
 * file dropped over an open modal called loadSource and reset the whole
 * viewer underneath it -- and a merge finishing afterwards then clobbered the
 * dropped file straight back. (Whether a merge is actually in flight is the
 * store's call; addFiles refuses while busy.)
 */
export async function openDroppedPdfs(sources: BytesDocumentSource[]): Promise<void> {
  if (sources.length === 0) return;
  const seed = sources.map((s) => ({ name: s.name ?? 'Untitled.pdf', bytes: s.data }));
  const combine = useCombineStore.getState();
  if (combine.modalOpen) {
    combine.addFiles(seed);
    return;
  }
  if (sources.length === 1) {
    await loadSource(sources[0]);
    return;
  }
  combine.open(seed);
}

/**
 * Open a document, taking the cross-feature lock for the duration.
 *
 * Loading replaces the engine's document and resets every per-fingerprint
 * store, so it is exactly the kind of change a mid-flight page op, text edit,
 * or image edit could be reloading on top of; see documentMutationStore.ts.
 * A blocked open says so rather than doing nothing: Open is reachable from a
 * dropped file and a keyboard shortcut as well as the menu, and only the menu
 * can be disabled up front.
 *
 * Resolves true only when the document actually loaded. A refused open (lock
 * held) and a failed one (error state) both resolve false without throwing, so
 * a caller cannot tell them from success by looking at the store afterwards:
 * on a refusal it still holds the previously open document.
 */
export async function loadSource(source: DocumentSource, options?: LoadOptions): Promise<boolean> {
  return withDocumentMutation(
    { owner: 'document', scope: 'pages' },
    () => loadSourceHoldingLock(source, options),
    () => {
      pushToast(DOCUMENT_MUTATION_BUSY_TITLE, 'info');
      announce(DOCUMENT_MUTATION_BUSY_TITLE, true);
      return false;
    },
  );
}

export interface LoadOptions {
  /**
   * Open at this page. It wins over the remembered reading position: a caller
   * that names a page (the post-update resume) knows better than the last
   * scroll, which that resume is itself reproducing.
   */
  page?: number;
}

/**
 * {@link loadSource}'s body, for the one caller that is already holding the
 * lock: combine finishes its own already-locked run by loading the merged
 * result (see runCombine in features/combine/commands.ts), and re-acquiring
 * here would refuse its own load.
 *
 * Split into a separate function rather than sniffing "is the lock free?" from
 * inside loadSource. That sniff could not tell combine's nesting apart from an
 * unrelated feature holding the lock, so it waved every concurrent caller
 * through -- a drop or a Ctrl+O landing mid-page-op would reset the stores to
 * the new document while the page op went on to reload the OLD one's bytes and
 * remap the OLD one's sidecar over them.
 */
export async function loadSourceHoldingLock(
  source: DocumentSource,
  options: LoadOptions = {},
): Promise<boolean> {
  // First, so the outgoing document's last page is written under its own key
  // rather than lost, or filed under the new document's once that is loaded.
  stopReadingPosition();
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
    const hash = await contentKey(source);
    const loaded = await engine.loadDocument(source);
    // The engine's fingerprint is a property of the template the file was
    // made from, not of the file (see contentKey.ts), so nothing downstream
    // sees it as the document's identity. It stays in `legacyKey` only to find
    // sidecar state saved under it by releases up to 0.8.1.
    const info = { ...loaded, fingerprint: hash ?? loaded.fingerprint };
    const legacyKey = loaded.fingerprint;
    const [metadata, outline] = await Promise.all([engine.getMetadata(), engine.getOutline()]);

    doc.setLoaded(info, metadata, outline);
    doc.setSourcePath(source.kind === 'bytes' ? (source.path ?? null) : null);
    // Page sizes are per document; a stale estimate would lay the new one out
    // at the old one's page size until each page measured itself.
    resetPageSizes();
    viewer.reset();
    viewer.setNumPages(info.numPages);
    const keys = await positionKeys(
      info.fingerprint,
      legacyKey,
      source.kind === 'bytes' ? (source.path ?? null) : null,
    );
    const resumedAt = restoreReadingPosition(keys, info.numPages, options);
    useAnnotationStore.getState().loadForDocument(info.fingerprint);
    useSignatureStore.getState().loadForDocument(info.fingerprint);
    useEditStore.getState().loadForDocument(info.fingerprint);
    useOcrStore.getState().loadForDocument(info.fingerprint);
    // After the four loads above: it asks whether any of them found nothing.
    useLegacySidecarStore.getState().detect(info.fingerprint, legacyKey);
    // Not persisted (nothing to load per fingerprint), but a fresh document is
    // never mid-edit, so any leftover session/undo history from a prior one goes.
    useTextEditStore.getState().reset();
    // Same again for page ops: a selection and an undo stack of the last
    // document's bytes mean nothing here, and restoring one would be a disaster.
    usePageOpsStore.getState().reset();
    usePlacementStore.getState().cancel();
    // The selected image is a locator into the last document's page content, and
    // the located-images cache is keyed on page index and docVersion, neither of
    // which distinguishes this document. Left alone, Delete would remove whichever
    // image here happens to match the stale selection.
    useImageEditStore.getState().reset();
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
    announce(
      `Opened ${info.name}, ${info.numPages} page${info.numPages === 1 ? '' : 's'}` +
        (resumedAt ? `, resumed at page ${resumedAt}` : ''),
    );
    // After the restore, never before: viewer.reset() above briefly puts the
    // viewer on page 1, and recording that would erase the page just read back.
    startReadingPosition(keys);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to open document';
    doc.setError(message);
    announce(`Could not open document: ${message}`, true);
    return false;
  }
}

/**
 * Jump to the page an explicit request or the reader's last visit names, and
 * return the page only when it was the remembered one (the caller announces
 * and toasts that case; an explicit page needs neither).
 */
function restoreReadingPosition(
  keys: PositionKeys,
  numPages: number,
  { page }: LoadOptions,
): number | null {
  const viewer = useViewerStore.getState();
  const usable = findPosition(keys, numPages);
  if (usable) {
    // Found by an alias: file it under this exact hash now, so the next open
    // matches directly instead of depending on the alias still holding.
    if (usable.via !== 'hash') setReadingPosition(keys, usable);
    // Straight into the store, not setScale: that would flip the fit mode to
    // custom, and the fit modes derive their own scale from the window. Before
    // goToPage so the page is laid out at the zoom it was left at.
    useViewerStore.setState(
      usable.fitMode === 'custom'
        ? { scale: usable.scale, fitMode: 'custom' }
        : { fitMode: usable.fitMode },
    );
  }
  if (page !== undefined) {
    if (page > 1) viewer.goToPage(page);
    return null;
  }
  if (!usable || usable.page <= 1) return null;
  viewer.goToPage(usable.page);
  return usable.page;
}

/**
 * Closing replaces the engine's document with nothing, exactly the kind of
 * change a mid-flight page op / text edit / image edit could be reloading on
 * top of; see documentMutationStore.ts.
 *
 * A blocked close reports it rather than resolving silently: File > Close is
 * disabled while the lock is held (see the command's `when` in
 * commands/defaultCommands.ts), but the command is also reachable from the
 * command palette and from a plugin, and "clicked Close, nothing happened, no
 * reason given" is the failure this whole lock is meant to avoid.
 */
export async function closeDocument(): Promise<void> {
  return withDocumentMutation(
    { owner: 'document', scope: 'pages' },
    async () => {
      // Before the reset below, which would put the viewer back on page 1.
      stopReadingPosition();
      await getEngine().closeDocument();
      resetPageSizes();
      useDocumentStore.getState().reset();
      useViewerStore.getState().reset();
      useAnnotationStore.getState().reset();
      useSignatureStore.getState().reset();
      useEditStore.getState().reset();
      useOcrStore.getState().reset();
      useLegacySidecarStore.getState().reset();
      useTextEditStore.getState().reset();
      usePageOpsStore.getState().reset();
      usePlacementStore.getState().cancel();
      useImageEditStore.getState().reset();
      useAddressHover.getState().clear();
      useSigningStore.getState().setDetected([]);
      document.title = 'Folio';
      pluginHost.clearActiveDocument();
      announce('Closed document');
    },
    () => {
      pushToast(DOCUMENT_MUTATION_BUSY_TITLE, 'info');
      announce(DOCUMENT_MUTATION_BUSY_TITLE, true);
    },
  );
}

/**
 * Swap the engine's document for freshly edited bytes (in-place text edits),
 * without resetting any per-feature store or changing the stored fingerprint:
 * unlike {@link loadSource}, this is still the same logical document, just
 * with new bytes, so per-fingerprint state (placed edits, signatures, OCR
 * text, annotations) must survive the reload untouched.
 */
export async function reloadEditedBytes(bytes: Uint8Array): Promise<void> {
  // This is the chokepoint the cross-feature lock exists to serialize, so it
  // is also where a caller that forgot to take it shows up. Development-only
  // and non-fatal: see the helper's own comment for why it complains rather
  // than acquiring on the caller's behalf.
  assertDocumentMutationHeld('reloadEditedBytes');

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
  // plugin, for one) runs past the end of a document that just
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
