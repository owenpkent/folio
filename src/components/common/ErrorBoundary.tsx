import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
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
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is the part that is not in error.stack, and it is
    // usually what identifies which page/layer blew up.
    console.error('[folio] unhandled render error', error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="folio-crash" role="alert">
        <h1 className="folio-crash__title">Folio hit an unexpected error</h1>
        <p className="folio-crash__body">
          The window has been left in a safe state. Reloading starts a fresh session; any document
          you had open will need to be opened again.
        </p>
        <pre className="folio-crash__detail">{error.message}</pre>
        <button type="button" className="folio-crash__action" onClick={this.handleReload}>
          Reload Folio
        </button>
      </div>
    );
  }
}
