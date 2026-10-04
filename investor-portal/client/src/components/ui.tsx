/** Small shared UI primitives (kept in one file so pages stay readable). */
import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import clsx from 'clsx';
import { bdt, titleCase } from '@/lib/format';

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg className={clsx('animate-spin text-brand-600', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-slate-500">
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description ? <p className="max-w-md text-sm text-slate-500">{description}</p> : null}
      {action}
    </div>
  );
}

export function Money({ poisha, className, decimals = false }: { poisha: string | number | null | undefined; className?: string; decimals?: boolean }) {
  return <span className={clsx('tabular-nums', className)}>{bdt(poisha, { decimals })}</span>;
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-700',
  PARTIALLY_PAID: 'bg-sky-50 text-sky-700',
  PAID: 'bg-emerald-50 text-emerald-700',
  OVERDUE: 'bg-rose-50 text-rose-700',
  WAIVED: 'bg-slate-100 text-slate-600',
  CANCELLED: 'bg-slate-100 text-slate-500',
  SUCCESS: 'bg-emerald-50 text-emerald-700',
  FAILED: 'bg-rose-50 text-rose-700',
  INITIATED: 'bg-slate-100 text-slate-600',
  REFUNDED: 'bg-purple-50 text-purple-700',
  ACTIVE: 'bg-emerald-50 text-emerald-700',
  INACTIVE: 'bg-slate-100 text-slate-600',
  COMPLETED: 'bg-brand-50 text-brand-700',
  SENT: 'bg-emerald-50 text-emerald-700',
  QUEUED: 'bg-amber-50 text-amber-700',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={clsx('badge', STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-600')}>{titleCase(status)}</span>;
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {error ? <p className="mt-1 text-xs text-rose-600">{error}</p> : hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={clsx('input', props.className)} />
);

export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={clsx('input', props.className)} />
);

export function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm text-slate-600">
      <span>
        {total} record{total === 1 ? '' : 's'}
      </span>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Previous
        </button>
        <span className="tabular-nums">
          {page} / {Math.max(totalPages, 1)}
        </span>
        <button type="button" className="btn-secondary" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

export function StatCard({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: string; tone?: 'default' | 'success' | 'danger' | 'brand' }) {
  return (
    <div className="card">
      <div className="card-body">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <p
          className={clsx(
            'mt-1 text-2xl font-semibold tabular-nums',
            tone === 'success' && 'text-emerald-600',
            tone === 'danger' && 'text-rose-600',
            tone === 'brand' && 'text-brand-700',
            tone === 'default' && 'text-slate-900',
          )}
        >
          {value}
        </p>
        {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
      </div>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8">
      <div className={clsx('card w-full', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <div className="card-header">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="card-body">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button type="button" className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={loading}>
            {loading ? <Spinner className="h-4 w-4" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-600">{message}</p>
    </Modal>
  );
}

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode }) {
  return (
    <div
      className={clsx(
        'rounded-lg border px-3 py-2 text-sm',
        kind === 'info' && 'border-brand-200 bg-brand-50 text-brand-800',
        kind === 'error' && 'border-rose-200 bg-rose-50 text-rose-700',
        kind === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-700',
        kind === 'warning' && 'border-amber-200 bg-amber-50 text-amber-800',
      )}
    >
      {children}
    </div>
  );
}
