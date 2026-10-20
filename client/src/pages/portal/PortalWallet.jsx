import { useState } from 'react';
import { useApi, useRefreshOnFocus } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { portalApi } from '../../services/endpoints.js';
import { Alert, Button, Card, Spinner, Table } from '../../components/ui.jsx';
import { WalletCard, WalletLedger, WalletRequestModal } from '../../components/WalletCard.jsx';
import { formatBDT, formatDateTime } from '../../utils/format.js';

/** Standalone wallet page (the profile tab shows the same widgets inline). */
export function PortalWallet() {
  const toast = useToast();
  const [modal, setModal] = useState(null);
  const { data, loading, error, reload } = useApi(() => portalApi.wallet(), []);
  useRefreshOnFocus(reload, { intervalMs: 60000 });

  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error.message}</Alert>;

  const summary = data?.summary ?? {};
  const transactions = data?.transactions ?? [];
  const pending = transactions.filter((tx) => tx.status === 'PENDING');

  const request = async (payload) => {
    await portalApi.requestWallet(payload);
    toast.success(payload.type === 'WITHDRAWAL' ? 'Withdrawal request sent' : 'Deposit request sent');
    setModal(null);
    reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My wallet</h1>
          <p className="muted">Every taka that moves in or out of your account, with the office’s approval trail.</p>
        </div>
      </div>

      <WalletCard
        summary={summary}
        title="Available balance"
        subtitle="Updated live from the office ledger"
        actions={
          <>
            <Button className="sm light" onClick={() => setModal('DEPOSIT')}>Deposit</Button>
            <Button className="sm" onClick={() => setModal('WITHDRAWAL')}>Withdraw</Button>
          </>
        }
      />

      <Card title="Pending requests" actions={<span className="small muted">{pending.length} awaiting approval</span>}>
        <Table
          rows={pending}
          empty="No pending requests."
          columns={[
            { key: 'requested_at', header: 'Requested', render: (row) => formatDateTime(row.requested_at ?? row.created_at) },
            { key: 'type_label', header: 'Type', render: (row) => row.type_label ?? row.type },
            { key: 'reference', header: 'Reference', mono: true, render: (row) => row.reference },
            { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
            { key: 'note', header: 'Note', render: (row) => row.note ?? '—' },
          ]}
        />
      </Card>

      <Card title="Activity">
        <WalletLedger transactions={transactions} />
      </Card>

      {modal ? <WalletRequestModal type={modal} onClose={() => setModal(null)} onSubmit={request} /> : null}
    </>
  );
}
