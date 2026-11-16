import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Changing this value resets the boundary (e.g. on route change). */
  resetKey?: string;
}

interface State {
  error: Error | null;
  info: string | null;
}

/**
 * Catches render-time failures so a single bad query or malformed record cannot
 * blank the whole application. Stored data is never modified here.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in component state only; nothing is transmitted anywhere.
    this.setState({ info: info.componentStack ?? null });
    console.error('Unhandled error in UI:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, info: null });
    }
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="p-6">
        <div className="card mx-auto max-w-2xl p-5">
          <h1 className="text-base font-semibold text-red-600 dark:text-red-400">
            Something went wrong on this page
          </h1>
          <p className="mt-2 text-sm text-muted">
            Your stored data has not been changed. Try reloading, or move to another page.
            If this keeps happening, export a backup from Settings before making further
            changes.
          </p>
          <pre className="mt-3 max-h-48 overflow-auto rounded bg-elevated p-2 text-xs text-muted">
            {error.message}
            {info ? `\n${info}` : ''}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={() => this.setState({ error: null, info: null })}
            >
              Try again
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => window.location.reload()}
            >
              Reload the application
            </button>
          </div>
        </div>
      </div>
    );
  }
}
