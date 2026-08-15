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
 * Whether a stored path is one worth handing to the file read on the next
 * launch.
 *
 * localStorage is not a trust boundary. Anything that can write the WebView
 * profile -- a renderer XSS, another local process, a hand-edited profile
 * directory -- can put a path here, and the Rust side's `read_document`
 * (src-tauri/src/lib.rs) checks only for a `.pdf` suffix before reading
 * whatever it is given. Validating the note's shape alone, as this used to,
 * leaves a "read any file named .pdf on the next launch" primitive behind a
 * single localStorage write.
 *
 * So the value is checked too: an absolute local path that ends in .pdf.
 * UNC paths are refused as well, because that is the form that turns a
 * localStorage write into an outbound SMB connection (and the Windows
 * credential handshake with it) at launch, before the user has touched
 * anything. The cost is that a document opened from a network share does not
 * reopen itself after an update; opening it by hand is unaffected, since that
 * path never comes through here.
 */
function isResumablePath(path: string): boolean {
  if (!path.toLowerCase().endsWith('.pdf')) return false;
  // \\server\share and //server/share.
  if (/^[\\/]{2}/.test(path)) return false;
  // A drive-qualified Windows path (C:\... or C:/...), or a POSIX absolute one.
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('/');
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
  if (!path || !isResumablePath(path)) {
    // Clear rather than leave a previous document's note behind: the user is
    // about to restart with nothing open (or with something this will not
    // reopen anyway), and restoring the document before last would be worse
    // than restoring none.
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
 * flowing into a file read. Both its shape and its path are checked; see
 * {@link isResumablePath} for why the path matters as much as the shape.
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
    if (typeof path !== 'string' || !isResumablePath(path)) return null;
    const safePage = typeof page === 'number' && Number.isFinite(page) ? Math.floor(page) : 1;
    return { path, page: Math.max(1, safePage) };
  } catch {
    return null;
  }
}
