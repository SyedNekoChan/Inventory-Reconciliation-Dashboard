import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { IconAlert, IconCheck, IconClose, IconWarning } from './icons';

export type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}

interface ToastContextValue {
  push: (tone: ToastTone, title: string, detail?: string) => void;
  success: (title: string, detail?: string) => void;
  error: (title: string, detail?: string) => void;
  info: (title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, title: string, detail?: string) => {
      const id = nextId;
      nextId += 1;
      setToasts((list) => [...list.slice(-4), { id, tone, title, detail }]);
      window.setTimeout(() => dismiss(id), tone === 'error' ? 9000 : 5000);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      success: (t, d) => push('success', t, d),
      error: (t, d) => push('error', t, d),
      info: (t, d) => push('info', t, d),
    }),
    [push],
  );

  const icons: Record<ToastTone, ReactNode> = {
    success: <IconCheck width={16} height={16} />,
    error: <IconAlert width={16} height={16} />,
    info: <IconWarning width={16} height={16} />,
  };

  const tones: Record<ToastTone, string> = {
    success: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
    error: 'border-red-500/40 text-red-700 dark:text-red-400',
    info: 'border-edge text-ink',
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto card border ${tones[toast.tone]} shadow-lg px-3 py-2.5 flex items-start gap-2.5`}
            role="status"
          >
            <span className="mt-0.5 shrink-0">{icons[toast.tone]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{toast.title}</p>
              {toast.detail ? (
                <p className="mt-0.5 text-xs text-muted break-words">{toast.detail}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-faint hover:text-ink"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
            >
              <IconClose width={13} height={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
