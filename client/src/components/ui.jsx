/** Small hand-written UI primitives (no component library). */
import { useEffect, useState } from 'react';
import { STATUS_LABELS, statusTone } from '../utils/format.js';

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header>
          {title ? <h2>{title}</h2> : null}
          <div className="spacer" />
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, hint, tone = '' }) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Badge({ status, label }) {
  if (!status && !label) return null;
  const text = label ?? STATUS_LABELS[status] ?? status;
  return <span className={`badge ${statusTone(status)}`}>{text}</span>;
}

export function Button({ variant = '', size = '', ...props }) {
  return <button {...props} className={`btn ${variant} ${size} ${props.className ?? ''}`} />;
}

export function Field({ label, error, help, children, hint }) {
  const child = children
    ? {
        ...children,
        props: { ...children.props, 'aria-invalid': error ? 'true' : undefined },
      }
    : null;
  return (
    <div className="field">
      {label ? <label htmlFor={children?.props?.id}>{label}</label> : null}
      {child}
      {hint ? <div className="help">{hint}</div> : null}
      {error ? <div className="error" role="alert">{error}</div> : null}
      {help ? <div className="help">{help}</div> : null}
    </div>
  );
}

export function Input({ value, onChange, ...props }) {
  return <input {...props} value={value ?? ''} onChange={(e) => onChange?.(e.target.value, e)} />;
}

export function Select({ value, onChange, options = [], children, ...props }) {
  return (
    <select {...props} value={value ?? ''} onChange={(e) => onChange?.(e.target.value, e)}>
      {children ??
        options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
    </select>
  );
}

export function Alert({ tone = 'info', children }) {
  if (!children) return null;
  return <div className={`alert ${tone}`}>{children}</div>;
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="empty">
      <span className="spinner" /> <span style={{ marginLeft: 8 }}>{label}</span>
    </div>
  );
}

export function EmptyState({ children = 'Nothing to show yet.' }) {
  return <div className="empty">{children}</div>;
}

export function Modal({ title, children, onClose, footer, width }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={width ? { width } : undefined} role="dialog" aria-modal="true">
        <header>
          <h3>{title}</h3>
          <div className="spacer" />
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Table({ columns, rows, empty = 'No records found.', keyField = 'id', footer = null, rowClassName, onRowClick = null }) {
  if (!rows?.length) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.align === 'right' ? 'num' : ''} style={column.width ? { width: column.width } : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row[keyField] ?? index}
              className={`${rowClassName?.(row) ?? ''} ${onRowClick ? 'clickable' : ''}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
            >
              {columns.map((column) => (
                <td key={column.key} className={`${column.align === 'right' ? 'num' : ''} ${column.mono ? 'mono' : ''}`}>
                  {column.render ? column.render(row, index) : row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot className="tfoot-total">
            <tr>{footer}</tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

export function Pagination({ meta, onPage }) {
  if (!meta) return null;
  return (
    <div className="pagination">
      <div>
        Page {meta.page} of {meta.pages} · {meta.total} record{meta.total === 1 ? '' : 's'}
      </div>
      <div className="inline">
        <button className="btn sm" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>
          ← Prev
        </button>
        <button className="btn sm" disabled={!meta.hasMore} onClick={() => onPage(meta.page + 1)}>
          Next →
        </button>
      </div>
    </div>
  );
}

/** Numbered sortable header helper. */
export function SortHeader({ column, sort, dir, onSort }) {
  const active = sort === column;
  return (
    <span role="button" tabIndex={0} onClick={() => onSort(column)} onKeyDown={() => onSort(column)}>
      {column} {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );
}

export function ConfirmButton({ onConfirm, children, confirmText = 'Confirm?', className = 'btn danger sm', ...props }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
      {...props}
    >
      {armed ? confirmText : children}
    </button>
  );
}

export function StatusPill({ status }) {
  return <Badge status={status} />;
}

/**
 * Responsive, accessible tab bar. On desktop it sticks under the top bar; on
 * phones it becomes a horizontally scrollable row (no wrapping, no hamburger).
 */
export function TabBar({ tabs, active, onChange, className = '' }) {
  return (
    <div className={`tabbar ${className}`} role="tablist" aria-label="Investor sections">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          id={`tab-${tab.key}`}
          aria-selected={tab.key === active}
          aria-controls={`tabpanel-${tab.key}`}
          className={`tab ${tab.key === active ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.icon ? <span aria-hidden="true">{tab.icon}</span> : null}
          {tab.label}
          {tab.count !== undefined && tab.count !== null ? <span className="tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Backwards-compatible alias used by older pages. */
export function Tabs({ tabs, active, onChange }) {
  return <TabBar tabs={tabs} active={active} onChange={onChange} />;
}

export function ProgressBar({ value = 0, tone = '', size = '', label = null }) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div>
      {label ? (
        <div className="stat-line" style={{ borderBottom: 0, paddingBottom: 2 }}>
          <span>{label}</span>
          <strong>{percent}%</strong>
        </div>
      ) : null}
      <div className={`progress ${tone} ${size}`} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

const BANNER_ICONS = { danger: '⚠', warn: '⏰', info: 'ℹ', ok: '✓', muted: '•' };

export function Banner({ tone = 'info', title, children, action }) {
  return (
    <div className={`banner ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="banner-icon" aria-hidden="true">{BANNER_ICONS[tone] ?? 'ℹ'}</div>
      <div className="banner-body">
        {title ? <div className="banner-title">{title}</div> : null}
        {children ? <div className="banner-text">{children}</div> : null}
      </div>
      {action ? <div className="banner-action">{action}</div> : null}
    </div>
  );
}

export function Avatar({ name = '?', src = null, size = '' }) {
  const initials = String(name)
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  if (src) return <img className={`avatar ${size}`} src={src} alt={name} style={{ objectFit: 'cover' }} />;
  return (
    <div className={`avatar ${size}`} aria-hidden="true">
      {initials || '?'}
    </div>
  );
}
