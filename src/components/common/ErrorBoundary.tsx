import type { Update } from '@tauri-apps/plugin-updater';
import { Component, createRef, type ErrorInfo, type ReactNode } from 'react';

import { findCrashUpdate, installCrashUpdate } from '@/features/updates/crashUpdate';

interface ErrorBoundaryProps {
  children: ReactNode;
}

/**
 * Where the crash screen's own update check has got to. `none` covers every
 * way of there being nothing to offer: not the desktop app, still checking,
 * up to date, or the check failed. None of those is worth a line on a screen
 * that already has bad news on it.
 */
type CrashUpdateState =
  | { status: 'none' }
  | { status: 'available'; version: string }
  | { status: 'installing'; version: string }
  | { status: 'failed'; version: string; reason: string };

interface ErrorBoundaryState {
  /** One safe line describing the failure, or null while everything is fine. */
  message: string | null;
  update: CrashUpdateState;
}

/** Shown when whatever was thrown carries nothing worth putting on screen. */
const GENERIC_MESSAGE = 'No further details are available.';

/** Longest detail line to render. Past this it is a log entry, not a message. */
const MAX_DETAIL = 300;

/**
 * Anything shaped like a filesystem path or a URL, captured down to its last
 * segment.
 *
 * The lookbehind keeps ordinary prose out of it: the bare `/` alternative only
 * starts a match at a boundary, so "and/or" is left alone while "/usr/lib/x.so"
 * is not.
 */
const PATH_LIKE =
  /(?<![\w.])(?:[a-z][a-z0-9+.-]*:\/\/|[A-Za-z]:[\\/]|\/)[^\s'"()]*[\\/]([^\s'"()\\/]*)/g;

/**
 * Reduce whatever was thrown to a single line fit to show the user.
 *
 * A throw is not required to be an Error. A string, a null, or a rejected value
 * from a library can all land here, and `error.message` on those is undefined,
 * which renders an empty detail box that tells the user nothing. `String(value)`
 * is no better: for a plain object it is "[object Object]".
 *
 * What does get shown is trimmed to the first line, so a thrown string carrying
 * a stack trace does not spill one, and has directories stripped out of anything
 * path-shaped. A bundler or worker failure quotes the full path it was loading,
 * which names the install location (and on Windows the account name) on a screen
 * the user is quite likely to screenshot into a bug report.
 */
function describeThrown(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  const line = raw.split('\n', 1)[0].replace(PATH_LIKE, '$1').trim();
  if (!line) return GENERIC_MESSAGE;
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL)}…` : line;
}

/**
 * Catches render-phase throws so a bug shows a message instead of a blank window.
 *
 * Without one, React unmounts the entire root fiber tree when any component
 * throws while rendering. `index.html`'s body holds nothing but `<div id="root">`,
 * so the result is a literal white screen: no toolbar, no error, nothing to
 * report. This turns that into something the user can act on and an operator can
 * diagnose.
 *
 * Note this is a backstop, not a safety net for the whole app: React error
 * boundaries do not see throws from event handlers, async callbacks, or
 * `setTimeout`, and they cannot catch a renderer process killed by the OS for
 * running out of memory. Those still need handling where they happen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { message: null, update: { status: 'none' } };

  private readonly headingRef = createRef<HTMLHeadingElement>();

  /** The release the crash screen found, kept out of state: it is a handle, not something to render. */
  private pendingUpdate: Update | null = null;
  private updateChecked = false;
  private unmounted = false;

  static getDerivedStateFromError(error: unknown): Pick<ErrorBoundaryState, 'message'> {
    return { message: describeThrown(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The component stack is the part that is not in error.stack, and it is
    // usually what identifies which page/layer blew up. This goes to the
    // console, not the screen, so it keeps the raw value and full detail.
    console.error('[folio] unhandled render error', error, info.componentStack);
  }

  componentDidMount(): void {
    // A child that throws on its very first render leaves this boundary still
    // mounting, so the fallback commits as part of the mount and never reaches
    // componentDidUpdate. That is the common case here: the boundary wraps the
    // whole app, and the throw that matters most happens at startup.
    if (this.state.message) this.enterFallback();
  }

  componentWillUnmount(): void {
    this.unmounted = true;
  }

  componentDidUpdate(_prevProps: ErrorBoundaryProps, prevState: ErrorBoundaryState): void {
    // Move focus into the fallback as it replaces the app. role="alert" gets
    // the text announced, but focus is still on an element React has just
    // unmounted, which leaves a keyboard user tabbing from nowhere and a
    // screen-reader user free to keep navigating a tree that is gone. The
    // heading takes it (tabIndex -1) rather than the button, so reading starts
    // at the top of the message and arrives at the recovery control in order.
    if (!prevState.message && this.state.message) this.enterFallback();
  }

  private enterFallback(): void {
    this.focusFallback();
    void this.checkForUpdate();
  }

  /**
   * Look once for a newer release. A build that crashes on launch can only be
   * replaced from here: the app's own update check runs inside the tree that
   * just failed (see features/updates/crashUpdate.ts).
   */
  private async checkForUpdate(): Promise<void> {
    if (this.updateChecked) return;
    this.updateChecked = true;
    const update = await findCrashUpdate();
    if (!update || this.unmounted) return;
    this.pendingUpdate = update;
    this.setState({ update: { status: 'available', version: update.version } });
  }

  private handleUpdate = async (): Promise<void> => {
    const update = this.pendingUpdate;
    if (!update) return;
    this.setState({ update: { status: 'installing', version: update.version } });
    try {
      await installCrashUpdate(update);
    } catch (error) {
      if (this.unmounted) return;
      this.setState({
        update: { status: 'failed', version: update.version, reason: describeThrown(error) },
      });
    }
  };

  private focusFallback(): void {
    this.headingRef.current?.focus();
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private renderUpdate(): ReactNode {
    const { update } = this.state;
    if (update.status === 'none') return null;
    return (
      // A status region of its own: it fills in after the alert has been read,
      // and has to be announced then without repeating the whole alert.
      <div className="folio-crash__update" role="status">
        {update.status === 'available' && (
          <>
            <p className="folio-crash__body">
              Folio {update.version} is available. Updating replaces this version, which may be what
              failed.
            </p>
            <button type="button" className="folio-crash__action" onClick={this.handleUpdate}>
              Update to {update.version} and restart
            </button>
          </>
        )}
        {update.status === 'installing' && (
          <p className="folio-crash__body">
            Downloading and installing Folio {update.version}. Folio restarts when it is done.
          </p>
        )}
        {update.status === 'failed' && (
          <p className="folio-crash__body">
            Folio {update.version} could not be installed: {update.reason} You can download it from
            the Folio releases page on GitHub.
          </p>
        )}
      </div>
    );
  }

  render(): ReactNode {
    const { message, update } = this.state;
    if (!message) return this.props.children;
    // With an update on offer, Reload is the second choice: reloading the
    // same build usually crashes the same way.
    const reloadClass =
      update.status === 'none'
        ? 'folio-crash__action'
        : 'folio-crash__action folio-crash__action--quiet';

    return (
      <div className="folio-crash" role="alert">
        <h1 className="folio-crash__title" ref={this.headingRef} tabIndex={-1}>
          Folio hit an unexpected error
        </h1>
        <p className="folio-crash__body">
          The window has been left in a safe state. Reloading starts a fresh session; any document
          you had open will need to be opened again.
        </p>
        <pre className="folio-crash__detail">{message}</pre>
        {this.renderUpdate()}
        <button
          type="button"
          className={reloadClass}
          onClick={this.handleReload}
          disabled={update.status === 'installing'}
        >
          Reload Folio
        </button>
      </div>
    );
  }
}
