/**
 * Donates: pick a welfare fund and an amount, pay through the payment gateway,
 * and keep a receipt for every successful donation.
 *
 * The result page (/portal/donates/result) never trusts the query string: it
 * reads the donation back from the server, which re-checks the gateway.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { portalApi } from '../../services/endpoints.js';
import { useApi, useRefreshOnFocus } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Kpi, Spinner, Table } from '../../components/ui.jsx';
import { formatBDT, formatDateTime } from '../../utils/format.js';

const CUSTOM = 'custom';
const TERMINAL = ['SUCCESS', 'FAILED', 'CANCELLED'];

/** Parses a typed taka amount. Returns { value, error }. */
export function parseTakaInput(raw, { min, max }) {
  const text = String(raw ?? '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { value: null, error: 'Enter an amount in taka, for example 500' };
  const value = Number(text);
  if (value < min) return { value: null, error: `The minimum donation is ${formatBDT(min * 100)}` };
  if (value > max) return { value: null, error: `The maximum donation is ${formatBDT(max * 100)}` };
  return { value, error: null };
}

export function PortalDonates() {
  const toast = useToast();
  const overview = useApi(() => portalApi.donations(), []);
  useRefreshOnFocus(overview.reload, { intervalMs: 60000 });

  const [fundCode, setFundCode] = useState(null);
  const [choice, setChoice] = useState(null); // preset amount (number) or CUSTOM
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [checkingId, setCheckingId] = useState(null);

  if (overview.loading && !overview.data) return <Spinner />;
  if (overview.error) return <Alert tone="error">{overview.error.message}</Alert>;
  const data = overview.data;
  if (!data) return <Spinner />;

  const funds = data.funds ?? [];
  const presets = data.presets_taka ?? [];
  const limits = { min: data.min_taka, max: data.max_taka };
  const selectedFund = funds.find((fund) => fund.code === (fundCode ?? funds[0]?.code)) ?? null;
  const activeChoice = choice ?? presets[1] ?? CUSTOM;
  const parsed =
    activeChoice === CUSTOM ? parseTakaInput(custom, limits) : { value: Number(activeChoice), error: null };
  const amount = parsed.value;

  const submit = async (event) => {
    event.preventDefault();
    setFormError(null);
    if (!selectedFund) return setFormError('Choose a fund to donate to');
    if (amount === null) return setFormError(parsed.error ?? 'Enter a valid amount');
    setBusy(true);
    try {
      const result = await portalApi.createDonation({ fundCode: selectedFund.code, amount });
      if (!result?.redirectUrl) throw new Error('The payment gateway did not return a payment link. Please try again.');
      window.location.assign(result.redirectUrl);
    } catch (err) {
      setFormError(err.message ?? 'Could not start the donation');
      toast.error(err.message ?? 'Could not start the donation');
      setBusy(false);
    }
  };

  const checkStatus = async (row) => {
    setCheckingId(row.id);
    try {
      const result = await portalApi.verifyDonation(row.id);
      toast.success(result.state === 'pending' ? 'Still waiting for the gateway' : `Donation ${result.state}`);
      overview.reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setCheckingId(null);
    }
  };

  return (
    <>
      <section className="hero rounded-2xl p-5" style={{ marginBottom: 16 }}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-wider text-sky-100">Donates</div>
            <h1 className="mt-1 text-2xl font-extrabold text-white">Support a welfare fund</h1>
            <p className="mt-1 text-sm text-sky-100">
              Your gift goes to the fund you choose. Every successful donation gets a receipt you can keep.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-center sm:w-64">
            <div className="rounded-xl bg-white/15 px-4 py-2">
              <div className="text-xs text-sky-100">Total donated</div>
              <div className="text-lg font-bold text-white">{formatBDT(data.totals?.total_donated ?? 0)}</div>
            </div>
            <div className="rounded-xl bg-white/15 px-4 py-2">
              <div className="text-xs text-sky-100">Donations</div>
              <div className="text-lg font-bold text-white">{data.totals?.count ?? 0}</div>
            </div>
          </div>
        </div>
      </section>

      <form onSubmit={submit} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="grid gap-4">
          <Card title="1. Choose a fund">
            <div className="fund-grid" role="radiogroup" aria-label="Donation fund">
              {funds.map((fund) => {
                const selected = (fundCode ?? funds[0]?.code) === fund.code;
                return (
                  <button
                    key={fund.code}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`fund-card ${selected ? 'selected' : ''}`}
                    onClick={() => setFundCode(fund.code)}
                  >
                    <span className="flex items-start gap-2">
                      <span className="fund-name">{fund.name}</span>
                      <span className="fund-tick" aria-hidden="true">✓</span>
                    </span>
                    <span className="fund-desc">{fund.description}</span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card title="2. Choose an amount">
            <div className="amount-chips" role="radiogroup" aria-label="Donation amount">
              {presets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  role="radio"
                  aria-checked={activeChoice === preset}
                  className={`amount-chip ${activeChoice === preset ? 'active' : ''}`}
                  onClick={() => {
                    setChoice(preset);
                    setFormError(null);
                  }}
                >
                  {formatBDT(preset * 100)}
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={activeChoice === CUSTOM}
                className={`amount-chip ${activeChoice === CUSTOM ? 'active' : ''}`}
                onClick={() => setChoice(CUSTOM)}
              >
                Other
              </button>
            </div>
            {activeChoice === CUSTOM ? (
              <div className="mt-4 max-w-xs">
                <label className="field" htmlFor="donate-amount">
                  <span className="small muted">Amount in taka (৳)</span>
                  <input
                    id="donate-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={`${limits.min} – ${limits.max.toLocaleString('en-US')}`}
                    value={custom}
                    onChange={(event) => setCustom(event.target.value)}
                    aria-invalid={Boolean(custom) && Boolean(parsed.error)}
                  />
                </label>
                {custom && parsed.error ? <div className="error">{parsed.error}</div> : null}
              </div>
            ) : null}
            <p className="small muted mt-3">
              Minimum {formatBDT(limits.min * 100)} · Maximum {formatBDT(limits.max * 100)} per donation
            </p>
          </Card>
        </div>

        <div className="grid gap-4 lg:sticky lg:top-20">
          <Card title="3. Pay securely">
            <div className="donate-summary">
              <div className="min-w-0">
                <div className="small muted">Donating to</div>
                <div className="font-semibold">{selectedFund?.name ?? 'Choose a fund'}</div>
              </div>
              <strong>{amount !== null ? formatBDT(amount * 100) : '—'}</strong>
            </div>
            {formError ? <Alert tone="error">{formError}</Alert> : null}
            <Button
              type="submit"
              variant="primary"
              className="donate-cta"
              disabled={busy || amount === null || !selectedFund}
            >
              {busy ? 'Opening payment…' : `Donate ${amount !== null ? formatBDT(amount * 100) : ''} with bKash`.trim()}
            </Button>
            <p className="small muted mt-3">
              You will be redirected to the payment gateway. We confirm the result with the gateway before we record it, so
              you are never charged twice for the same donation.
            </p>
          </Card>
          <Kpi label="Receipts" value={String(data.totals?.count ?? 0)} hint="Every successful donation has a receipt" />
        </div>
      </form>

      <Card
        title="My donations"
        actions={<span className="small muted">Most recent first</span>}
        className="mt-4"
      >
        <Table
          rows={data.history ?? []}
          empty="No donations yet. Your first gift will appear here with its receipt."
          columns={[
            { key: 'created_at', header: 'Date', render: (row) => formatDateTime(row.paid_at ?? row.created_at) },
            {
              key: 'receipt_number',
              header: 'Receipt',
              mono: true,
              render: (row) => row.receipt_number,
            },
            { key: 'fund_name', header: 'Fund' },
            { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
            { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (row) => {
                if (row.status === 'SUCCESS') {
                  return (
                    <Button className="sm ghost" onClick={() => portalApi.openDonationReceipt(row.id)}>
                      Receipt
                    </Button>
                  );
                }
                if (!TERMINAL.includes(row.status)) {
                  return (
                    <Button className="sm" disabled={checkingId === row.id} onClick={() => checkStatus(row)}>
                      {checkingId === row.id ? 'Checking…' : 'Check status'}
                    </Button>
                  );
                }
                return null;
              },
            },
          ]}
        />
      </Card>

      <p className="small muted mt-4 text-center">
        Need help with a donation? <Link to="/portal/support">Contact support</Link>
      </p>
    </>
  );
}

const RESULT_COPY = {
  failed: { title: 'Donation not completed', tone: 'error', text: 'The payment was not completed. No money was taken for this donation.' },
  cancelled: { title: 'Donation cancelled', tone: 'warn', text: 'You cancelled the payment. You can try again whenever you like.' },
  pending: { title: 'Waiting for confirmation', tone: 'info', text: 'The gateway has not confirmed this payment yet. Check again in a moment.' },
  error: { title: 'We could not confirm the donation', tone: 'error', text: 'Something went wrong while checking the payment. Nothing has been double-charged. Try the check again.' },
};

/** Which copy to show: the server's record wins over the query-string hint. */
export function resultKey(status, requestedState) {
  if (status === 'FAILED') return 'failed';
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'PENDING' || status === 'INITIATED') return 'pending';
  return Object.hasOwn(RESULT_COPY, requestedState) ? requestedState : 'error';
}

export function PortalDonateResult() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const ref = searchParams.get('ref');
  const requestedState = searchParams.get('state') ?? 'error';
  const reason = searchParams.get('reason');
  const detail = useApi(() => (ref ? portalApi.donation(ref) : Promise.resolve(null)), [ref], { immediate: Boolean(ref) });
  const [checking, setChecking] = useState(false);

  const donation = detail.data?.donation ?? null;
  // The server's record is the source of truth; the query string is only a hint.
  const status = donation?.status ?? null;
  const isSuccess = status === 'SUCCESS' || (!donation && requestedState === 'success');

  const recheck = async () => {
    if (!donation) return;
    setChecking(true);
    try {
      await portalApi.verifyDonation(donation.id);
      await detail.reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setChecking(false);
    }
  };

  if (detail.loading && !detail.data) return <Spinner />;

  if (isSuccess) {
    return (
      <div className="mx-auto w-full max-w-md">
        <div className="soon-card rounded-2xl border border-sky-100 bg-white shadow-soft">
          <div className="success-burst" aria-hidden="true">✓</div>
          <h1 className="text-xl">Thank you for your donation</h1>
          <p className="muted mt-1">
            {donation ? `${formatBDT(donation.amount)} to ${donation.fund_name}` : 'Your donation was received.'}
          </p>
          {donation ? (
            <div className="mt-4 text-left">
              <div className="receipt-line"><span>Receipt</span><strong className="mono">{donation.receipt_number}</strong></div>
              <div className="receipt-line"><span>Transaction ID</span><strong className="mono">{donation.trx_id ?? '—'}</strong></div>
              <div className="receipt-line"><span>Paid on</span><strong>{donation.paid_at ? formatDateTime(donation.paid_at) : '—'}</strong></div>
            </div>
          ) : null}
          <div className="mt-5 grid grid-cols-2 gap-3">
            {donation ? (
              <Button className="sm primary" style={{ padding: 12 }} onClick={() => portalApi.openDonationReceipt(donation.id)}>
                View receipt
              </Button>
            ) : null}
            <Button className="sm" style={{ padding: 12 }} onClick={() => navigate('/portal/donates')}>
              Back to donates
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const copy = RESULT_COPY[resultKey(status, requestedState)];
  return (
    <div className="mx-auto w-full max-w-md">
      <Card title={copy.title}>
        <Alert tone={copy.tone}>{copy.text}</Alert>
        {reason === 'missing_payment' ? <p className="small muted">The payment reference was missing from the return link.</p> : null}
        {donation ? (
          <div className="mt-3">
            <div className="receipt-line"><span>Receipt</span><strong className="mono">{donation.receipt_number}</strong></div>
            <div className="receipt-line"><span>Amount</span><strong>{formatBDT(donation.amount)}</strong></div>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {donation && !TERMINAL.includes(status) ? (
            <Button className="sm primary" disabled={checking} onClick={recheck}>
              {checking ? 'Checking…' : 'Check again'}
            </Button>
          ) : null}
          <Button className="sm" onClick={() => navigate('/portal/donates')}>
            {status === 'FAILED' || status === 'CANCELLED' || requestedState === 'error' ? 'Try again' : 'Back to donates'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
