import { useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { ThemeProvider } from './components/ThemeProvider';
import { ToastProvider } from './components/ToastProvider';
import { ensureSchemaVersion } from './db/settings';
import { db } from './db/database';
import { OverviewPage } from './pages/OverviewPage';
import { InventoryPage } from './pages/InventoryPage';
import { ReconciliationPage } from './pages/ReconciliationPage';
import { MappingPage } from './pages/MappingPage';
import { ImportsPage } from './pages/ImportsPage';
import { ImportHistoryPage } from './pages/ImportHistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { LoadingBlock } from './components/ui/Primitives';
import { ErrorBoundary } from './components/ErrorBoundary';

export function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await db.open();
        await ensureSchemaVersion();
        if (!cancelled) setReady(true);
      } catch (err) {
        if (!cancelled) {
          setFatal(
            err instanceof Error
              ? err.message
              : 'The local database could not be opened.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (fatal) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="card max-w-lg p-5">
          <h1 className="text-base font-semibold">Local storage unavailable</h1>
          <p className="mt-2 text-sm text-muted">
            This application stores all data in your browser using IndexedDB, and the
            database could not be opened.
          </p>
          <p className="mt-2 text-sm text-muted">
            This usually means the browser is in private mode, site data is blocked, or
            storage is full.
          </p>
          <pre className="mt-3 overflow-x-auto rounded bg-elevated p-2 text-xs text-muted">
            {fatal}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <ThemeProvider>
      <ErrorBoundary>
      <ToastProvider>
        {/*
          HashRouter is used deliberately: GitHub Pages serves static files only
          and cannot rewrite deep links to index.html.
        */}
        <HashRouter>
          {ready ? (
            <Routes>
              <Route element={<AppLayout />} path="/">
                <Route index element={<OverviewPage />} />
                <Route path="inventory" element={<InventoryPage />} />
                <Route path="reconciliation" element={<ReconciliationPage />} />
                <Route path="mapping" element={<MappingPage />} />
                <Route path="imports" element={<ImportsPage />} />
                <Route path="import-history" element={<ImportHistoryPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          ) : (
            <LoadingBlock label="Opening local database…" />
          )}
        </HashRouter>
      </ToastProvider>
      </ErrorBoundary>
    </ThemeProvider>
  );
}
