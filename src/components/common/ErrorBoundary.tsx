import { Component, createRef, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  /** One safe line describing the failure, or null while everything is fine. */
  message: string | null;
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
  state: ErrorBoundaryState = { message: null };

  private readonly headingRef = createRef<HTMLHeadingElement>();

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
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
    if (this.state.message) this.focusFallback();
  }

  componentDidUpdate(_prevProps: ErrorBoundaryProps, prevState: ErrorBoundaryState): void {
    // Move focus into the fallback as it replaces the app. role="alert" gets
    // the text announced, but focus is still on an element React has just
    // unmounted, which leaves a keyboard user tabbing from nowhere and a
    // screen-reader user free to keep navigating a tree that is gone. The
    // heading takes it (tabIndex -1) rather than the button, so reading starts
    // at the top of the message and arrives at the recovery control in order.
    if (!prevState.message && this.state.message) this.focusFallback();
  }

  private focusFallback(): void {
    this.headingRef.current?.focus();
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { message } = this.state;
    if (!message) return this.props.children;

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
        <button type="button" className="folio-crash__action" onClick={this.handleReload}>
          Reload Folio
        </button>
      </div>
    );
  }
}
