/**
 * Investor-facing payment page: /pay/:token
 * Minimal by design - first name, installment number, amount, due date. No NID,
 * no full mobile number, no login. Errors are deliberately generic.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { publicApi } from '../../services/endpoints.js';
import { formatBDT, formatDate, dueLabel } from '../../utils/format.js';

export function PayPage() {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await publicApi.viewLink(token);
        if (!cancelled) setState({ loading: false, data, error: null });
      } catch (err) {
        if (!cancelled) setState({ loading: false, data: null, error: err });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const pay = async () => {
    setStarting(true);
    try {
      const result = await publicApi.start(token);
      window.location.assign(result.redirectUrl);
    } catch (err) {
      setState((current) => ({ ...current, error: err }));
      setStarting(false);
    }
  };

  if (state.loading) {
    return (
      <div className="public-wrap">
        <div className="pay-card">
          <div className="pay-body center">
            <span className="spinner" />
            <p className="muted" style={{ marginTop: 12 }}>Loading your payment details…</p>
          </div>
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="public-wrap">
        <div className="pay-card">
          <div className="pay-head">
            <h1 style={{ margin: 0, color: '#fff', fontSize: '1.1rem' }}>Payment link not available</h1>
          </div>
          <div className="pay-body">
            <p>
              {state.error.code === 'LINK_EXPIRED'
                ? 'This payment link has expired.'
                : 'This payment link is not valid.'}
            </p>
            <p className="muted small">
              If you received a newer SMS from us, please use the newest payment link. Otherwise contact the office and we
              will send you a fresh link.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const data = state.data;
  const settled = data.settled;

  return (
    <div className="public-wrap">
      <div className="pay-card">
        <div className="pay-head">
          <div style={{ fontSize: '0.78rem', letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.8 }}>
            {data.businessName}
          </div>
          <h1 style={{ margin: '6px 0 0', color: '#fff' }}>Hello, {data.firstName}</h1>
          <div style={{ opacity: 0.85, fontSize: '0.88rem' }}>Installment payment</div>
        </div>

        <div className="pay-body">
          <div className="muted small">Amount payable</div>
          <div className="pay-amount">{formatBDT(data.amount)}</div>

          <div className="pay-rows">
            <div className="pay-row">
              <span>Installment</span>
              <span>
                #{data.installmentNumber} of {data.installmentCount}
              </span>
            </div>
            <div className="pay-row">
              <span>Due date</span>
              <span>
                {formatDate(data.dueDate)} <span className="muted small">{dueLabel(data.dueDate)}</span>
              </span>
            </div>
            {data.amountPaid > 0 ? (
              <div className="pay-row">
                <span>Already paid</span>
                <span>{formatBDT(data.amountPaid)}</span>
              </div>
            ) : null}
            <div className="pay-row">
              <span>Status</span>
              <span>
                {data.status}
                {data.overdue ? ' · overdue' : ''}
              </span>
            </div>
            <div className="pay-row">
              <span>Registered mobile</span>
              <span className="mono">{data.mobileHint}</span>
            </div>
          </div>

          {settled ? (
            <div className="alert ok" style={{ marginBottom: 0 }}>
              This installment is already settled ({data.status}). No payment is needed. Thank you!
            </div>
          ) : (
            <>
              <button type="button" className="bkash-btn" onClick={pay} disabled={starting}>
                {starting ? 'Opening bKash…' : 'Pay with bKash'}
              </button>
              <p className="muted small center" style={{ marginTop: 12, marginBottom: 0 }}>
                You will be redirected to bKash to complete the payment. Your installment is marked paid only after our
                server verifies the transaction with bKash.
              </p>
            </>
          )}

          {state.error && !settled ? <div className="alert error" style={{ marginTop: 12 }}>{state.error.message}</div> : null}
        </div>
      </div>
    </div>
  );
}
