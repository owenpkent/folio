import { create } from 'zustand';

/**
 * Shared `title` text for a disabled control whose only reason for being
 * disabled right now is the cross-feature lock, so every feature explains it
 * to the user in the same words rather than each inventing its own.
 */
export const DOCUMENT_MUTATION_BUSY_TITLE = 'Another document change is in progress.';

interface DocumentMutationState {
  /**
   * True from the moment any feature starts rewriting the open document's
   * bytes, or replacing it outright, until that finishes, successfully or
   * not. Page operations, text editing, image editing, OCR recognition,
   * combine, and save/sign all read and write state that is not safe to
   * interleave with another one of them mid-flight: two features racing to
   * call `reloadEditedBytes` (state/actions.ts) leaves whichever one lands
   * second silently discarding the other's change, and page ops' undo
   * snapshots (features/pageops/pageState.ts) can silently discard a
   * later edit the same way. This is the one lock every mutating entry
   * point checks before starting and holds for as long as it runs, so only
   * one of them is ever mid-flight at a time.
   *
   * Each feature keeps its own local busy flag too (pageops' `busy`,
   * combine's `busy` and `inFlight`, ...), which still guards a second
   * attempt at the SAME operation exactly as it did before this existed.
   * This flag is only for a DIFFERENT feature trying to start.
   */
  inFlight: boolean;
  begin(): void;
  end(): void;
}

/**
 * The cross-feature "a document mutation is in flight" lock, owned here
 * rather than inside pageops, textedit, imageedit, or any other single
 * feature, because none of them is entitled to decide when the others may
 * run. See the field doc above for what it protects.
 */
export const useDocumentMutationStore = create<DocumentMutationState>((set) => ({
  inFlight: false,
  begin: () => set({ inFlight: true }),
  end: () => set({ inFlight: false }),
}));
