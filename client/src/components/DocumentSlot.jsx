/**
 * Reusable document slot: image preview, plus (for staff, when canUpload is set)
 * drag & drop upload, cropper and a Verify / Reject overlay. Without canUpload the
 * slot is view-only, which is how the investor portal shows every document.
 *
 * One component drives all four profile documents — Photo, NID front, NID back
 * and Signature — in the admin profile and the investor portal. The parent owns
 * the API calls (upload/review) so the same UI works with both session types.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Badge, Button, Field, Modal } from './ui.jsx';

const ASPECT = { PHOTO: 1, NOMINEE_PHOTO: 1, SIGNATURE: 3, NID_FRONT: 1.586, NID_BACK: 1.586 };
const ACCEPT_IMAGES = 'image/jpeg,image/png';
const ACCEPT_WITH_PDF = 'image/jpeg,image/png,application/pdf';

export const DOCUMENT_STATUS_TONE = {
  MISSING: 'muted',
  PENDING: 'warn',
  VERIFIED: 'ok',
  REJECTED: 'danger',
};

function humanSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentSlot({
  kind,
  label,
  slot = null,
  url = null,
  upload,
  review = null,
  canUpload = false,
  canReview = false,
  hint = null,
  onChanged,
  nomineeId = null,
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [crop, setCrop] = useState(null);
  const [viewing, setViewing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [bust, setBust] = useState(0);

  const allowPdf = kind === 'NID_FRONT' || kind === 'NID_BACK';
  const hasFile = Boolean(slot?.has_file);
  const status = slot?.status ?? 'MISSING';
  const statusLabel = { MISSING: 'Not uploaded', PENDING: 'Pending review', VERIFIED: 'Verified', REJECTED: 'Rejected' }[status] ?? status;
  const fileUrl = url ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(slot?.uploaded_at ?? '')}-${bust}` : null;

  const runUpload = useCallback(
    async (file) => {
      if (!file || !upload) return;
      setBusy(true);
      setError(null);
      try {
        await upload(file);
        setBust((n) => n + 1);
        onChanged?.();
      } catch (err) {
        setError(err.message ?? 'Upload failed');
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [upload, onChanged],
  );

  const pick = (file) => {
    if (!file) return;
    const isPdf = file.type === 'application/pdf';
    if (isPdf) {
      if (!allowPdf) {
        setError('Only JPEG or PNG images are accepted here');
        return;
      }
      runUpload(file);
      return;
    }
    if (!/^image\/(jpeg|png)$/.test(file.type)) {
      setError('Only JPEG or PNG images are accepted');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setCrop({ src: String(reader.result), name: file.name });
    reader.onerror = () => setError('Could not read that file');
    reader.readAsDataURL(file);
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    if (!canUpload || busy) return;
    pick(event.dataTransfer.files?.[0]);
  };

  return (
    <div className="doc-slot">
      <div className="doc-head">
        <strong>{label}</strong>
        <div className="spacer" />
        <span className={`doc-status ${status}`}>{statusLabel}</span>
      </div>

      {hasFile && fileUrl ? (
        slot?.mime === 'application/pdf' ? (
          <button
            type="button"
            className="doc-drop"
            onClick={() => window.open(fileUrl, '_blank', 'noopener')}
            style={{ cursor: 'pointer' }}
          >
            <div>
              <div className="doc-icon" aria-hidden="true">📄</div>
              <div style={{ fontWeight: 600, color: 'var(--text)' }}>PDF on file</div>
              <div className="doc-hint">{humanSize(slot?.size)} · click to open</div>
            </div>
          </button>
        ) : (
          <img className={`doc-thumb ${kind === 'SIGNATURE' ? 'contain' : ''}`} src={fileUrl} alt={label} onClick={() => setViewing(true)} />
        )
      ) : canUpload ? (
        <div
          className={`doc-drop ${dragging ? 'dragover' : ''}`}
          role="button"
          tabIndex={0}
          aria-label={`Upload ${label}`}
          onClick={() => !busy && inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div>
            <div className="doc-icon" aria-hidden="true">{dragging ? '⬇' : '＋'}</div>
            <div style={{ fontWeight: 600, color: 'var(--text)' }}>{`Upload ${label.toLowerCase()}`}</div>
            <div className="doc-hint">Drag & drop or click · JPEG/PNG</div>
          </div>
          {busy ? <div className="doc-busy">Uploading…</div> : null}
        </div>
      ) : (
        // View-only (investor portal): nothing to click, so no drop zone is shown.
        <div className="doc-drop doc-readonly" aria-disabled="true">
          <div>
            <div className="doc-icon" aria-hidden="true">🗂</div>
            <div style={{ fontWeight: 600, color: 'var(--text)' }}>Not on file yet</div>
            <div className="doc-hint">Managed by the office. Ask support if this is wrong.</div>
          </div>
        </div>
      )}

      {hasFile && busy ? <div className="small muted">Uploading replacement…</div> : null}

      <div className="doc-actions">
        {canUpload ? (
          <Button
            type="button"
            className="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              inputRef.current?.click();
            }}
          >
            {hasFile ? 'Replace' : 'Choose file'}
          </Button>
        ) : null}
        {hasFile && fileUrl ? (
          <Button type="button" className="sm ghost" onClick={() => window.open(fileUrl, '_blank', 'noopener')}>
            View
          </Button>
        ) : null}
        {canReview && hasFile && review ? (
          <Button type="button" className="sm primary" onClick={() => setReviewing(true)}>
            Verify / Reject
          </Button>
        ) : null}
      </div>

      {hint ? <div className="small muted">{hint}</div> : null}
      {error ? <div className="field"><div className="error">{error}</div></div> : null}
      {slot?.review_note ? <div className="doc-note">Reviewer note: {slot.review_note}</div> : null}

      <input
        ref={inputRef}
        type="file"
        accept={allowPdf ? ACCEPT_WITH_PDF : ACCEPT_IMAGES}
        style={{ display: 'none' }}
        onChange={(event) => pick(event.target.files?.[0])}
      />

      {crop ? (
        <ImageCropper
          src={crop.src}
          aspect={ASPECT[kind] ?? 1}
          title={`Crop ${label.toLowerCase()}`}
          onCancel={() => setCrop(null)}
          onApply={(file) => {
            setCrop(null);
            runUpload(file);
          }}
        />
      ) : null}

      {viewing && fileUrl ? (
        <Modal title={label} onClose={() => setViewing(false)} width="min(760px, 100%)">
          <img src={fileUrl} alt={label} style={{ width: '100%', borderRadius: 10, border: '1px solid var(--border)' }} />
          <div className="inline" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <Button onClick={() => setViewing(false)}>Close</Button>
          </div>
        </Modal>
      ) : null}

      {reviewing && review ? (
        <ReviewModal
          label={label}
          current={status}
          onClose={() => setReviewing(false)}
          onDone={async (payload) => {
            await review(payload);
            setReviewing(false);
            setBust((n) => n + 1);
            onChanged?.();
          }}
        />
      ) : null}
      {nomineeId ? <span className="small muted mono">Nominee #{nomineeId}</span> : null}
    </div>
  );
}

function ReviewModal({ label, current, onClose, onDone }) {
  const [status, setStatus] = useState('VERIFIED');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (status === 'REJECTED' && !note.trim()) {
      setError('Add a short reason so the member knows what to fix');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onDone({ status, note: note.trim() || undefined });
    } catch (err) {
      setError(err.message ?? 'Could not save the review');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Review ${label.toLowerCase()}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="small muted">
          Current status: <Badge label={current} status={current === 'VERIFIED' ? 'PAID' : current === 'REJECTED' ? 'FAILED' : 'PENDING'} />
        </p>
        <Field label="Decision">
          <div className="inline">
            <label className="inline small">
              <input type="radio" name="review-status" checked={status === 'VERIFIED'} onChange={() => setStatus('VERIFIED')} /> Verify
            </label>
            <label className="inline small">
              <input type="radio" name="review-status" checked={status === 'REJECTED'} onChange={() => setStatus('REJECTED')} /> Reject
            </label>
          </div>
        </Field>
        <Field label={status === 'REJECTED' ? 'Reason (required)' : 'Note (optional)'} error={error}>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="e.g. NID number does not match the typed NID" />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <Button type="button" className="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Save review'}</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Dependency-free image cropper: fixed-aspect stage, drag to pan, slider to zoom,
 * exported to a JPEG at 1000px wide. Matches the wallet/profile visual language.
 */
export function ImageCropper({ src, aspect = 1, title = 'Crop image', onCancel, onApply }) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const dragRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [stageWidth, setStageWidth] = useState(480);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      setReady(true);
    };
    image.onerror = () => setReady(false);
    image.src = src;
  }, [src]);

  useEffect(() => {
    const measure = () => {
      if (stageRef.current) setStageWidth(stageRef.current.clientWidth || 480);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const stageHeight = Math.round(stageWidth / aspect);

  const geometry = useCallback(() => {
    const image = imageRef.current;
    if (!image) return null;
    const base = Math.max(stageWidth / image.naturalWidth, stageHeight / image.naturalHeight);
    const scale = base * zoom;
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    const maxX = Math.max(0, (drawWidth - stageWidth) / 2);
    const maxY = Math.max(0, (drawHeight - stageHeight) / 2);
    return { image, drawWidth, drawHeight, maxX, maxY };
  }, [stageWidth, stageHeight, zoom]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const geometryValue = geometry();
    if (!canvas || !geometryValue) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(stageWidth * dpr);
    canvas.height = Math.round(stageHeight * dpr);
    const context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, stageWidth, stageHeight);
    context.fillStyle = '#0f172a';
    context.fillRect(0, 0, stageWidth, stageHeight);
    const x = (stageWidth - geometryValue.drawWidth) / 2 + offset.x;
    const y = (stageHeight - geometryValue.drawHeight) / 2 + offset.y;
    context.drawImage(geometryValue.image, x, y, geometryValue.drawWidth, geometryValue.drawHeight);
  }, [geometry, offset, stageWidth, stageHeight, ready]);

  const clamp = (next, nextZoom = zoom) => {
    const image = imageRef.current;
    if (!image) return next;
    const base = Math.max(stageWidth / image.naturalWidth, stageHeight / image.naturalHeight);
    const drawWidth = image.naturalWidth * base * nextZoom;
    const drawHeight = image.naturalHeight * base * nextZoom;
    const maxX = Math.max(0, (drawWidth - stageWidth) / 2);
    const maxY = Math.max(0, (drawHeight - stageHeight) / 2);
    return { x: Math.min(maxX, Math.max(-maxX, next.x)), y: Math.min(maxY, Math.max(-maxY, next.y)) };
  };

  const onPointerDown = (event) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, origin: offset };
  };
  const onPointerMove = (event) => {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    setOffset(clamp({ x: dragRef.current.origin.x + dx, y: dragRef.current.origin.y + dy }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const apply = () => {
    const geometryValue = geometry();
    if (!geometryValue) return;
    setBusy(true);
    const outputWidth = 1000;
    const outputHeight = Math.round(outputWidth / aspect);
    const ratio = outputWidth / stageWidth;
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, outputWidth, outputHeight);
    const x = ((stageWidth - geometryValue.drawWidth) / 2 + offset.x) * ratio;
    const y = ((stageHeight - geometryValue.drawHeight) / 2 + offset.y) * ratio;
    context.drawImage(geometryValue.image, x, y, geometryValue.drawWidth * ratio, geometryValue.drawHeight * ratio);
    canvas.toBlob(
      (blob) => {
        setBusy(false);
        if (!blob) return;
        onApply(new File([blob], `crop-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      },
      'image/jpeg',
      0.92,
    );
  };

  return (
    <Modal title={title} onClose={onCancel}>
      <div
        ref={stageRef}
        className="cropper-stage"
        style={{ aspectRatio: String(aspect) }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
        {!ready ? <div className="doc-busy">Loading image…</div> : null}
      </div>
      <div className="cropper-controls">
        <span className="small muted">Zoom</span>
        <input
          type="range"
          min="1"
          max="3"
          step="0.01"
          value={zoom}
          onChange={(event) => {
            const nextZoom = Number(event.target.value);
            setZoom(nextZoom);
            setOffset((current) => clamp(current, nextZoom));
          }}
        />
        <span className="small muted">{Math.round(zoom * 100)}%</span>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>
        Drag the image to reposition it inside the frame, then save. The cropped image is uploaded — the original file
        never leaves your device.
      </p>
      <div className="inline" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        <Button type="button" className="sm" onClick={onCancel}>Cancel</Button>
        <Button type="button" variant="primary" size="sm" disabled={!ready || busy} onClick={apply}>
          {busy ? 'Preparing…' : 'Crop & upload'}
        </Button>
      </div>
    </Modal>
  );
}
