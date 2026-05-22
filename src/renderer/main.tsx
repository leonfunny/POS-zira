import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import rlog from './utils/logger';
import './index.css';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    rlog.error('[App] Render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-gradient-to-br from-white via-rose-50 to-amber-50 text-slate-900">
          <div className="text-center">
            <h1 className="mb-4 text-4xl font-bold text-slate-900">Application Error</h1>
            <p className="mb-6 text-slate-500">{this.state.error?.message}</p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="rounded-xl bg-brand-500 px-6 py-3 text-lg font-medium text-white transition-colors hover:bg-brand-600"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
