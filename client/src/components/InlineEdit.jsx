/**
 * Inline profile field: renders the value, or an "Add …" trigger when the value
 * is missing. Clicking edits in place and saves with a single API call, so the
 * member profile never shows a dead "N/A".
 */
import { useEffect, useState } from 'react';
import { Button, Input, Select } from './ui.jsx';

export function InlineEditField({
  label,
  field,
  value,
  type = 'text',
  options = null,
  placeholder = '',
  hint = null,
  canEdit = false,
  locked = false,
  onSave,
  display = null,
  maxLength = 500,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  const submit = async (event) => {
    event?.preventDefault?.();
    setBusy(true);
    setError(null);
    try {
      await onSave(field, draft);
      setEditing(false);
    } catch (err) {
      const details = err?.details;
      setError(details?.[field] ?? details?.value ?? err?.message ?? 'Could not save this field');
    } finally {
      setBusy(false);
    }
  };

  const shown = display ?? (value ? String(value) : null);

  return (
    <div className="stat-line" style={{ alignItems: editing ? 'flex-start' : 'center' }}>
      <span style={{ minWidth: 130 }}>{label}</span>
      <div style={{ flex: 1, textAlign: 'right' }}>
        {editing ? (
          <form onSubmit={submit} className="inline-edit-form" style={{ textAlign: 'left' }}>
            {options ? (
              <Select
                value={draft}
                onChange={setDraft}
                options={options}
                autoFocus
              />
            ) : type === 'textarea' ? (
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={maxLength} autoFocus />
            ) : (
              <Input
                type={type}
                value={draft}
                onChange={setDraft}
                placeholder={placeholder}
                maxLength={maxLength}
                autoFocus
              />
            )}
            {hint ? <div className="help">{hint}</div> : null}
            {error ? <div className="error">{error}</div> : null}
            <div className="row">
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setDraft(value ?? '');
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="inline-value" style={{ justifyContent: 'flex-end' }}>
            {shown ? <strong style={{ fontWeight: 600 }}>{shown}</strong> : <span className="muted">Not provided</span>}
            {locked ? (
              <span className="locked-tag" title="Changed by the office after identity verification">
                🔒 Office
              </span>
            ) : null}
            {canEdit && onSave && !locked ? (
              <button type="button" className="inline-add" onClick={() => setEditing(true)}>
                {shown ? 'Edit' : '+ Add'}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
