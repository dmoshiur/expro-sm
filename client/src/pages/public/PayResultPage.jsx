/**
 * Result page after the gateway redirect: /pay/:token/result
 * The outcome shown here comes from the SERVER (which re-queries the gateway),
 * never from the query string alone.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { publicApi } from '../../services/endpoints.js';
import { formatBDT, formatDate } from '../../utils/format.js';

export function PayResultPage() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const paymentId = searchParams.get('paymentID') ?? searchParams.get('paymentId') ?? '';
  const stateParam = searchParams.get('state') ?? 'unknown';
  const [status, setStatus] = useState({ loading: Boolean(paymentId && token), data: null, error: null });
  const [attempts, setAttempts] = useState(0);

  const verify = useCallback(async () => {
    if (!token || !paymentId) {
      setStatus({ loading: false, data: null, error: null });
      return;
    }
    try {
      const data = await publicApi.verify(token, paymentId);
      setStatus({ loading: false, data, error: null });
    } catch (err) {
      setStatus({ loading: false, data: null, error: err });
    }
  }, [token, paymentId]);

  useEffect(() => {
    verify();
  }, [verify]);

  // Poll a few times while the gateway/bank is still settling.
  useEffect(() => {
    const pending = status.data?.state === 'pending' || (!status.data && stateParam === 'pending');
    if (!pending || attempts >= 4) return undefined;
    const timer = setTimeout(() => {
      setAttempts((value) => value + 1);
      verify();
    }, 4000);
    return () => clearTimeout(timer);
  }, [status, attempts, verify, stateParam]);

  const outcome = status.data?.state ?? stateParam;
  const isSuccess = outcome === 'success';
  const isPending = outcome === 'pending';
  const headline = isSuccess
    ? 'Payment successful'
    : isPending
      ? 'Payment is being confirmed'
      : outcome === 'cancelled'
        ? 'Payment cancelled'
        : outcome === 'failed'
          ? 'Payment failed'
          : 'Payment status unavailable';

  return (
    <div className="public-wrap">
      <div className="pay-card">
        <div className="pay-head" style={{ background: isSuccess ? '#0f7a4a' : isPending ? '#a15c07' : '#b42318' }}>
          <h1 style={{ margin: 0, color: '#fff', fontSize: '1.2rem' }}>{headline}</h1>
        </div>
        <div className="pay-body">
          {status.loading ? (
            <p className="center">
              <span className="spinner" /> <span style={{ marginLeft: 8 }}>Verifying with bKash…</span>
            </p>
          ) : null}

          {status.data ? (
            <>
              <div className="pay-rows">
                <div className="pay-row">
                  <span>Amount</span>
                  <span>{formatBDT(status.data.payment.amount)}</span>
                </div>
                <div className="pay-row">
                  <span>Transaction ID</span>
                  <span className="mono">{status.data.payment.trxId ?? '—'}</span>
                </div>
                <div className="pay-row">
                  <span>Receipt number</span>
                  <span className="mono">{status.data.payment.receiptNumber}</span>
                </div>
                <div className="pay-row">
                  <span>Status</span>
                  <span>{status.data.payment.status}</span>
                </div>
                {status.data.installment ? (
                  <div className="pay-row">
                    <span>Installment</span>
                    <span>
                      #{status.data.installment.installmentNumber} · {status.data.installment.status}
                      {status.data.installment.status !== 'PAID' ? ` · due ${formatDate(status.data.installment.dueDate)}` : ''}
                    </span>
                  </div>
                ) : null}
              </div>

              {isSuccess ? (
                <div className="alert ok">
                  Thank you. Your installment has been recorded as paid and our office can see it immediately.
                </div>
              ) : null}
              {isPending ? (
                <div className="alert warn">
                  bKash has not confirmed the transaction yet. If money left your account, it will be applied
                  automatically - you do not need to pay again. This page refreshes itself a few times.
                </div>
              ) : null}
              {!isSuccess && !isPending ? (
                <div className="alert error">
                  Nothing has been deducted for this attempt. You can try again from your payment link.
                </div>
              ) : null}
            </>
          ) : (
            <p className="muted">We could not look up this payment. Please contact the office with your bKash message.</p>
          )}

          {status.error ? <div className="alert error">{status.error.message}</div> : null}

          {token ? (
            <p className="center" style={{ marginTop: 14, marginBottom: 0 }}>
              <Link className="btn" to={`/pay/${token}`}>
                Back to payment page
              </Link>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
