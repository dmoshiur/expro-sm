import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { investmentsApi, installmentsApi, investorsApi } from '../../services/endpoints.js';
import { useApi, useDebounce, useAction } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Button, Card, Field, Input, Select, Spinner } from '../../components/ui.jsx';
import { formatBDT, takaToPoisha } from '../../utils/format.js';

function splitPoisha(total, count) {
  if (!Number.isSafeInteger(total) || total <= 0 || count < 1) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  const amounts = new Array(count).fill(base);
  amounts[count - 1] = base + remainder;
  return amounts;
}

function buildDueDates(first, count, interval) {
  if (!first || count < 1) return [];
  const [y, m, d] = first.split('-').map(Number);
  const dates = [];
  for (let i = 0; i < count; i += 1) {
    if (interval === 'WEEKLY') {
      const base = new Date(Date.UTC(y, m - 1, d));
      base.setUTCDate(base.getUTCDate() + i * 7);
      dates.push(base.toISOString().slice(0, 10));
    } else {
      const year = y + Math.floor((m - 1 + i) / 12);
      const month = ((m - 1 + i) % 12) + 1;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      dates.push(`${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`);
    }
  }
  return dates;
}

export function InvestmentNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const action = useAction();

  const [investorId, setInvestorId] = useState(searchParams.get('investorId') ?? '');
  const [investorSearch, setInvestorSearch] = useState('');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [count, setCount] = useState('12');
  const [firstDueDate, setFirstDueDate] = useState(() => {
    const today = new Date(Date.now() + 6 * 3600_000);
    today.setUTCDate(today.getUTCDate() + 7);
    return today.toISOString().slice(0, 10);
  });
  const [interval, setInterval] = useState('MONTHLY');
  const [notes, setNotes] = useState('');
  const [sendLinks, setSendLinks] = useState(false);
  const [error, setError] = useState(null);
  const debouncedSearch = useDebounce(investorSearch);

  const investors = useApi(
    () => investorsApi.list({ search: debouncedSearch, status: 'ACTIVE', limit: 30 }),
    [debouncedSearch],
  );
  const selected = useApi(() => (investorId ? investorsApi.get(investorId) : Promise.resolve(null)), [investorId], {
    immediate: Boolean(investorId),
  });

  const totalPoisha = takaToPoisha(amount);
  const countNumber = Number(count) || 0;
  const preview = useMemo(() => {
    if (!totalPoisha || !countNumber) return { amounts: [], dates: [], sum: 0 };
    const amounts = splitPoisha(totalPoisha, countNumber);
    const dates = buildDueDates(firstDueDate, countNumber, interval);
    return { amounts, dates, sum: amounts.reduce((s, a) => s + a, 0) };
  }, [totalPoisha, countNumber, firstDueDate, interval]);

  const sumMatches = totalPoisha === preview.sum && totalPoisha > 0;

  useEffect(() => {
    if (countNumber > 120) setCount('120');
  }, [countNumber]);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    if (!investorId) {
      setError('Choose an investor first');
      return;
    }
    if (!totalPoisha || totalPoisha <= 0) {
      setError('Enter a valid total amount');
      return;
    }
    if (!sumMatches) {
      setError('The installment split does not add up to the total');
      return;
    }
    try {
      const result = await action.run(() =>
        investmentsApi.create({
          investorId: Number(investorId),
          totalAmount: amount,
          installmentCount: countNumber,
          firstDueDate,
          interval,
          title: title || undefined,
          notes: notes || undefined,
        }),
      );
      if (sendLinks) {
        const ids = (result.investment.installments ?? []).map((row) => row.id);
        if (ids.length) await action.run(() => installmentsApi.bulkSendLinks(ids.slice(0, 50)));
      }
      toast.success('Investment created with its installment schedule');
      navigate(`/investments/${result.investment.id}`);
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>New investment</h1>
        <div className="spacer" />
        <Button type="button" className="sm" onClick={() => navigate(-1)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={action.busy || !sumMatches}>
          {action.busy ? 'Creating…' : 'Create investment'}
        </Button>
      </div>

      <Alert tone="error">{error}</Alert>

      <div className="grid cols-2">
        <Card title="Investor">
          <Field label="Search investor" hint="Only active investors can receive new investments.">
            <Input value={investorSearch} onChange={setInvestorSearch} placeholder="Name or mobile" />
          </Field>
          <Field label="Investor">
            <Select
              value={investorId}
              onChange={setInvestorId}
              options={[
                { value: '', label: 'Select an investor…' },
                ...(investors.data?.items ?? []).map((row) => ({
                  value: String(row.id),
                  label: `${row.name} · ${row.mobile_masked ?? row.mobile}`,
                })),
              ]}
            />
          </Field>
          {selected.data ? (
            <div className="small muted">
              {selected.data.investments.length} existing investment(s) · total{' '}
              {formatBDT(selected.data.investments.reduce((s, v) => s + Number(v.total_amount), 0))}
            </div>
          ) : null}

          <div className="form-row" style={{ marginTop: 12 }}>
            <Field label="Total amount (BDT)" hint="Amounts are stored as integer poisha."
              error={amount && !totalPoisha ? 'Enter a valid amount' : undefined}>
              <Input value={amount} onChange={setAmount} inputMode="decimal" placeholder="1200000.00" required />
            </Field>
            <Field label="Installments" hint="1–120">
              <Input type="number" min="1" max="120" value={count} onChange={setCount} required />
            </Field>
          </div>
          <div className="form-row">
            <Field label="First due date">
              <Input type="date" value={firstDueDate} onChange={setFirstDueDate} required />
            </Field>
            <Field label="Interval">
              <Select
                value={interval}
                onChange={setInterval}
                options={[
                  { value: 'MONTHLY', label: 'Monthly' },
                  { value: 'WEEKLY', label: 'Weekly' },
                ]}
              />
            </Field>
          </div>
          <Field label="Title (optional)">
            <Input value={title} onChange={setTitle} maxLength={160} placeholder="Business expansion capital" />
          </Field>
          <Field label="Notes (optional)">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </Field>
          <label className="inline small">
            <input type="checkbox" checked={sendLinks} onChange={(e) => setSendLinks(e.target.checked)} /> Send payment links by SMS
            after creating (first 50)
          </label>
        </Card>

        <Card title="Schedule preview">
          <div className={`alert ${sumMatches ? 'ok' : 'warn'}`}>
            Total {formatBDT(totalPoisha ?? 0)} split into {preview.amounts.length} installment(s) ·{' '}
            <strong>sum {formatBDT(preview.sum)}</strong> {sumMatches ? '✓ matches' : '— must match the total'}
          </div>
          {preview.amounts.length === 0 ? (
            <p className="muted small">Enter an amount and a count to preview the split. The rounding remainder is added to the last installment.</p>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Amount</th>
                    <th>Due date</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.amounts.map((value, index) => (
                    <tr key={index}>
                      <td>#{index + 1}</td>
                      <td className="num">{formatBDT(value)}</td>
                      <td>{preview.dates[index]}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="tfoot-total">
                  <tr>
                    <td>Total</td>
                    <td className="num">{formatBDT(preview.sum)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {investors.loading ? <Spinner label="Loading investors…" /> : null}
        </Card>
      </div>
    </form>
  );
}
