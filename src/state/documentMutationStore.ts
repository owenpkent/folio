import { create } from 'zustand';

/**
 * Shared `title` text for a disabled control whose only reason for being
 * disabled right now is the cross-feature lock, so every feature explains it
 * to the user in the same words rather than each inventing its own.
 */
export const DOCUMENT_MUTATION_BUSY_TITLE = 'Another document change is in progress.';

/**
 * Which feature is holding the lock.
 *
 * Recorded so a feature can tell its OWN operation apart from someone else's.
 * A lock with no owner cannot: every control a feature disables while it works
 * ends up blaming "another document change" for the change the user just asked
 * that very feature to make, which is both wrong and alarming.
 */
export type MutationOwner =
  /** Open and close: the document itself is being replaced or torn down. */
  | 'document'
  | 'pageops'
  | 'combine'
  | 'textedit'
  | 'imageedit'
  /** Save, Save a copy, Print, and digital signing: all read the same snapshot. */
  | 'export'
  | 'ocr';

/**
 * What an operation writes, which is what decides who may overlap with whom.
 *
 * - `pages` replaces the open document or renumbers its pages: Open, Close,
 *   Combine, and every page operation. Every per-fingerprint sidecar store
 *   (placed edits, signatures, OCR words, annotations) is keyed to the page map
 *   this changes, and pageops' own snapshot/remap of those stores
 *   (features/pageops/pageState.ts) is the thing most of this lock exists for.
 * - `content` rewrites the bytes of the pages that are already there, or reads
 *   a consistent snapshot of them, leaving the page map alone: in-place text
 *   edits, image edits, Save, Print, digital signing.
 * - `sidecar` writes per-fingerprint sidecar state for the page map it started
 *   on and touches no bytes at all: OCR recognition, which fills the OCR store
 *   page by page over a run that can take minutes on a long document.
 *
 * The conflict rule is symmetric and has exactly one exemption: everything
 * excludes everything else, EXCEPT `content` and `sidecar`, which may run
 * together. See {@link conflicts}.
 */
export type MutationScope = 'pages' | 'content' | 'sidecar';

export interface MutationRequest {
  owner: MutationOwner;
  scope: MutationScope;
}

/** A mutation currently holding the lock. */
interface HeldMutation extends MutationRequest {
  /** Identifies this acquisition, so a release can recognise its own. */
  token: number;
}

/**
 * Release the lock this acquisition took. Idempotent, and inert once a later
 * acquisition has superseded it, so double-releasing cannot unlock somebody
 * else's operation.
 */
export type ReleaseMutation = () => void;

/**
 * Whether an operation writing `a` may overlap one writing `b`.
 *
 * Only one pair may: an OCR run and a content-only change. OCR writes words
 * keyed to the page map it started on, and a text edit, an image edit, a save
 * or a print leaves that page map exactly as it was, so neither can invalidate
 * the other. Making that one pair legal is what keeps a multi-minute
 * recognition run from freezing Save, Sign, Print, and both in-place editors
 * for its whole duration over a conflict it does not actually have.
 */
function conflicts(a: MutationScope, b: MutationScope): boolean {
  if (a === 'sidecar' && b === 'content') return false;
  if (a === 'content' && b === 'sidecar') return false;
  return true;
}

interface DocumentMutationState {
  /**
   * Every mutation currently in flight. Usually zero or one: it holds two only
   * in the one case {@link conflicts} allows to overlap.
   *
   * A feature keeps its own local busy flag too (pageops' `busy`, combine's
   * `busy` and `inFlight`, ...), which still guards a second attempt at the
   * SAME operation exactly as it did before this existed and also drives that
   * feature's own progress UI.
   */
  active: HeldMutation[];
  /** Monotonic; the next acquisition's token. */
  nextToken: number;
  /**
   * Take the lock, or return null when something conflicting already holds it.
   * Prefer {@link withDocumentMutation} to calling this directly: it is what
   * guarantees the release runs.
   */
  acquire(request: MutationRequest): ReleaseMutation | null;
}

/**
 * The cross-feature "a document mutation is in flight" lock, owned here rather
 * than inside pageops, textedit, imageedit, or any other single feature,
 * because none of them is entitled to decide when the others may run.
 *
 * Two features racing to call `reloadEditedBytes` (state/actions.ts) leaves
 * whichever one lands second silently discarding the other's change, and page
 * ops' undo snapshots (features/pageops/pageState.ts) can silently discard a
 * later edit the same way. This is the one lock every mutating entry point
 * goes through before starting.
 */
export const useDocumentMutationStore = create<DocumentMutationState>((set, get) => ({
  active: [],
  nextToken: 1,
  acquire: (request) => {
    const { active, nextToken } = get();
    if (active.some((held) => conflicts(held.scope, request.scope))) return null;

    const token = nextToken;
    set({ active: [...active, { ...request, token }], nextToken: token + 1 });

    let released = false;
    return () => {
      // Guarded twice on purpose. `released` makes a double release from the
      // same caller free, and filtering by token means a release that somehow
      // arrives late cannot drop a DIFFERENT acquisition that is still running.
      // The old begin()/end() pair could do exactly that, which is why callers
      // had to hand-roll "do I own this?" bookkeeping before starting.
      if (released) return;
      released = true;
      set({ active: get().active.filter((held) => held.token !== token) });
    };
  },
}));

/**
 * Whether an operation by `owner` writing `scope` would be refused right now
 * because something ELSE holds the lock. `owner`'s own in-flight operation is
 * deliberately not counted: a feature already knows about its own work (that is
 * what its local busy flag is for) and must not report it as somebody else's.
 */
export function isDocumentMutationBlocked(
  active: readonly HeldMutation[],
  owner: MutationOwner,
  scope: MutationScope,
): boolean {
  return active.some((held) => held.owner !== owner && conflicts(held.scope, scope));
}

/** {@link isDocumentMutationBlocked} against the live store, for guards outside React. */
export function documentMutationBlocked(owner: MutationOwner, scope: MutationScope): boolean {
  return isDocumentMutationBlocked(useDocumentMutationStore.getState().active, owner, scope);
}

/**
 * Whether an {@link DocumentMutationState.acquire} of `scope` would be refused
 * right now, counting the caller's OWN in-flight work as well as everyone
 * else's.
 *
 * This is the question a handler has to answer before something downstream
 * claims the change happened: a keyboard delete arriving while this feature's
 * previous commit is still landing is refused just as firmly as one arriving
 * during another feature's, and announcing "deleted" over either is equally
 * wrong. {@link documentMutationBlocked} deliberately ignores the caller's own
 * work and is the wrong question here.
 */
export function documentMutationWouldBlock(scope: MutationScope): boolean {
  return useDocumentMutationStore.getState().active.some((held) => conflicts(held.scope, scope));
}

/**
 * What to tell the user when a mutation was refused: whose fault it was decides
 * the wording.
 *
 * "Another document change is in progress" is a lie when the thing in progress
 * is the user's own last edit to this very feature, which is the shape a
 * debounced commit lands in most often. An ownerless boolean could not tell
 * those apart and said the cross-feature sentence for both.
 */
export function documentMutationBusyMessage(owner: MutationOwner, scope: MutationScope): string {
  return documentMutationBlocked(owner, scope)
    ? DOCUMENT_MUTATION_BUSY_TITLE
    : 'That change is still being saved. Try again in a moment.';
}

/**
 * {@link isDocumentMutationBlocked} as a hook, for disabling a control and
 * explaining why with {@link DOCUMENT_MUTATION_BUSY_TITLE}.
 */
export function useDocumentMutationBlocked(owner: MutationOwner, scope: MutationScope): boolean {
  return useDocumentMutationStore((s) => isDocumentMutationBlocked(s.active, owner, scope));
}

/**
 * Run `body` holding the lock, releasing it however `body` ends; run `onBusy`
 * instead, without acquiring anything, when something conflicting is already in
 * flight.
 *
 * Every mutating entry point goes through this rather than acquiring by hand.
 * The hand-written form was the same six lines at fifteen call sites, and the
 * copies had already drifted: one took the lock outside its own `try` (so a
 * throw in between stranded it for the rest of the session), and two entry
 * points that needed it never took it at all.
 */
export async function withDocumentMutation<T>(
  request: MutationRequest,
  body: () => Promise<T>,
  onBusy: () => T,
): Promise<T> {
  const release = useDocumentMutationStore.getState().acquire(request);
  if (!release) return onBusy();
  try {
    return await body();
  } finally {
    release();
  }
}

/**
 * Complain in development when the document's bytes are being swapped with no
 * lock held.
 *
 * `reloadEditedBytes` is the chokepoint every byte rewrite funnels through, so
 * a caller that reaches it without having acquired anything is a bug in that
 * caller, not something to paper over here: swallowing it (by acquiring on its
 * behalf) would hide the race rather than fix it, and would deadlock the
 * legitimate nested call, where the caller is already holding the lock on
 * purpose.
 */
export function assertDocumentMutationHeld(what: string): void {
  if (import.meta.env.PROD) return;
  if (useDocumentMutationStore.getState().active.length > 0) return;
  console.error(
    `${what} ran without the document mutation lock held. ` +
      'Wrap the caller in withDocumentMutation (see state/documentMutationStore.ts).',
  );
}
