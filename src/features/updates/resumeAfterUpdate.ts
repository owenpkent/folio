import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

/**
 * Where the pre-relaunch note lives. localStorage rather than a new store
 * plugin: the WebView2 / WKWebView profile directory outlives an in-place
 * update (the installer replaces the binary, not the user data dir), and the
 * theme preference already relies on the same guarantee.
 */
const RESUME_KEY = 'folio:resume-after-update';

/** What we need to put the reader back where they were. */
interface ResumeNote {
  path: string;
  page: number;
}

/**
 * Remember the open document so the relaunch that finishes an update can
 * reopen it.
 *
 * Only path-backed documents qualify. A PDF that arrived as bytes -- dropped
 * from a browser file picker, fetched through a `folio://` deep link -- has
 * nothing on disk to reopen, and `sourcePath` is null for exactly those (see
 * documentStore). Nothing is written in that case, so the relaunched app
 * starts empty rather than pointing at a path that was never ours.
 */
export function rememberOpenDocument(): void {
  const path = useDocumentStore.getState().sourcePath;
  if (!path) {
    // Clear rather than leave a previous document's note behind: the user is
    // about to restart with nothing open, and restoring the document before
    // last would be worse than restoring none.
    forgetOpenDocument();
    return;
  }
  const note: ResumeNote = { path, page: useViewerStore.getState().currentPage };
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(note));
  } catch {
    // Storage disabled or full. Reopening is a convenience; losing it must
    // never block the update itself.
  }
}

/** Drop any pending note without reading it. */
export function forgetOpenDocument(): void {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    // Nothing to do: see rememberOpenDocument.
  }
}

/**
 * Read and clear the note left before an update relaunch.
 *
 * Consume-once, mirroring the Rust side's `take_launch_file`: the note means
 * "this one restart should reopen that file", not "always reopen it". Clearing
 * it before it is acted on also means a path that somehow crashes the open
 * cannot do so on every subsequent launch.
 *
 * The stored value is re-validated rather than trusted: it is JSON from disk,
 * and a half-written or hand-edited entry should read as "no note" instead of
 * flowing into a file read as an arbitrary shape.
 */
export function takeResumeDocument(): ResumeNote | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(RESUME_KEY);
  } catch {
    return null;
  }
  forgetOpenDocument();
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { path, page } = parsed as Partial<ResumeNote>;
    if (typeof path !== 'string' || path.length === 0) return null;
    const safePage = typeof page === 'number' && Number.isFinite(page) ? Math.floor(page) : 1;
    return { path, page: Math.max(1, safePage) };
  } catch {
    return null;
  }
}
