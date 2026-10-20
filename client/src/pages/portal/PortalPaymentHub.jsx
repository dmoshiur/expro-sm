/**
 * Payment & wallet hub: the one place for "what do I owe and how do I pay".
 * It summarises money state and links to the detailed installment, payment
 * and wallet pages.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { portalApi } from '../../services/endpoints.js';
import { useApi, useRefreshOnFocus } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Spinner } from '../../components/ui.jsx';
import { WalletCard } from '../../components/WalletCard.jsx';
import { formatBDT, formatDate, dueLabel } from '../../utils/format.js';

const TILES = [
  { to: '/portal/installments', title: 'Installments', text: 'Full schedule, paid and open', icon: '≡' },
  { to: '/portal/payments', title: 'Payments', text: 'Every payment with receipts', icon: '৳' },
  { to: '/portal/wallet', title: 'Wallet', text: 'Balance, deposits and withdrawals', icon: '◈' },
];

export function PortalPaymentHub() {
  const navigate = useNavigate();
  const toast = useToast();
  const [payingId, setPayingId] = useState(null);
  const dashboard = useApi(() => portalApi.dashboard(), []);
  const wallet = useApi(() => portalApi.wallet(), []);
  useRefreshOnFocus(() => {
    dashboard.reload();
    wallet.reload();
  }, { intervalMs: 60000 });

  if (dashboard.loading && !dashboard.data) return <Spinner />;
  if (dashboard.error) return <Alert tone="error">{dashboard.error.message}</Alert>;
  const { summary, upcoming_installments: upcoming, profile } = dashboard.data;
  const walletSummary = wallet.data?.summary ?? dashboard.data.wallet ?? null;
  const next = upcoming[0] ?? null;
  const frozen = Boolean(profile.is_frozen);

  const payNow = async (row) => {
    setPayingId(row.id);
    try {
      const link = await portalApi.payLink(row.id);
      navigate(link.path);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPayingId(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Payment &amp; wallet</h1>
          <p className="muted">Pay what is due, track every payment and manage your wallet.</p>
        </div>
      </div>

      {frozen ? (
        <Alert tone="error">
          Your account is frozen{profile.frozen_reason ? `: ${profile.frozen_reason}` : ''}. Installment payments are
          suspended until the office lifts the freeze.
        </Alert>
      ) : null}

      <div className="grid cols-2" style={{ alignItems: 'start', marginBottom: 14 }}>
        <WalletCard
          summary={walletSummary}
          title="My wallet"
          subtitle="Live ledger balance"
          actions={<Button className="sm light" onClick={() => navigate('/portal/wallet')}>Open wallet</Button>}
        />

        <Card title="Next payment">
          {next ? (
            <div className="stack" style={{ gap: 10 }}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-500">
                    Installment #{next.serial}{next.investment_title ? ` · ${next.investment_title}` : ''}
                  </div>
                  <div className="text-2xl font-extrabold text-slate-900">{formatBDT(next.outstanding)}</div>
                  <div className="text-sm text-slate-500">
                    Due {formatDate(next.due_date)} <span>({dueLabel(next.due_date)})</span>
                  </div>
                </div>
                <Badge status={frozen && next.effective_status !== 'PAID' ? 'SUSPENDED' : next.effective_status} />
              </div>
              <Button
                variant="primary"
                className="donate-cta"
                disabled={frozen || payingId === next.id}
                onClick={() => payNow(next)}
              >
                {payingId === next.id ? 'Opening payment…' : `Pay ${formatBDT(next.outstanding)} now`}
              </Button>
              <div className="small muted">
                Due now {formatBDT(summary.due_now)} · Overdue {summary.overdue_count} installment(s)
              </div>
            </div>
          ) : (
            <div className="empty">Nothing is due. Every installment is settled. 🎉</div>
          )}
        </Card>
      </div>

      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        {TILES.map((tile) => (
          <Link
            key={tile.to}
            to={tile.to}
            className="card flex items-center gap-4 no-underline hover:no-underline"
            style={{ margin: 0 }}
          >
            <span className="grid h-12 w-12 flex-none place-items-center rounded-2xl bg-sky-100 text-xl text-sky-800" aria-hidden="true">
              {tile.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-bold text-slate-900">{tile.title}</span>
              <span className="block text-sm text-slate-500">{tile.text}</span>
            </span>
            <span className="text-slate-400" aria-hidden="true">›</span>
          </Link>
        ))}
      </div>
    </>
  );
}
