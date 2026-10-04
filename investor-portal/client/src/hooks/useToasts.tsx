import { useCallback, useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ToastContext, type Toast, type ToastContextValue } from './toast-context';

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: Toast['kind'], message: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((current) => [...current, { id, kind, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5000);
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ push, success: (message) => push('success', message), error: (message) => push('error', message) }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={clsx(
              'pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg',
              toast.kind === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-800',
              toast.kind === 'error' && 'border-rose-200 bg-rose-50 text-rose-800',
              toast.kind === 'info' && 'border-slate-200 bg-white text-slate-700',
            )}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
