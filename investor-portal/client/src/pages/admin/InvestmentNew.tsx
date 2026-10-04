import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { investmentService } from '@/services/investment.service';
import { investorService } from '@/services/investor.service';
import { errorMessage } from '@/services/api';
import { useToast } from '@/hooks/useToast';
import { bdt, todayDhaka } from '@/lib/format';
import { Alert, Field, Input, Loading, Select, Spinner } from '@/components/ui';

const schema = z.object({
  investorId: z.string().uuid('Select an investor'),
  totalAmount: z
    .string()
    .min(1, 'Amount is required')
    .refine((value) => Number(value) > 0, 'Amount must be greater than zero')
    .refine((value) => /^\d+(\.\d{1,2})?$/.test(value), 'Use up to two decimal places'),
  installmentCount: z.coerce.number().int().min(1, 'At least one installment').max(120, 'Maximum 120 installments'),
  firstDueDate: z.string().min(10, 'First due date is required'),
  intervalUnit: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']),
  intervalValue: z.coerce.number().int().min(1).max(60),
  notes: z.string().max(500).optional(),
});
type FormValues = z.infer<typeof schema>;

/** Mirrors the server split: equal poisha with the remainder on the LAST installment. */
function previewSplit(amount: string, count: number): string[] {
  const total = Math.round(Number(amount || '0') * 100);
  if (!Number.isFinite(total) || count < 1) return [];
  const base = Math.floor(total / count);
  const rows = Array.from({ length: count }, () => base);
  rows[count - 1] = base + (total - base * count);
  return rows.map((value) => String(value));
}

export default function InvestmentNew() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      investorId: params.get('investorId') ?? '',
      totalAmount: '',
      installmentCount: 3,
      firstDueDate: todayDhaka(),
      intervalUnit: 'MONTH',
      intervalValue: 1,
    },
  });

  const [investorQuery, setInvestorQuery] = useState('');
  const investors = useQuery({ queryKey: ['investors', 'picker', investorQuery], queryFn: () => investorService.list({ search: investorQuery || undefined, pageSize: 50, status: 'ACTIVE' }) });

  const values = watch();
  const split = useMemo(() => previewSplit(values.totalAmount, Number(values.installmentCount)), [values.totalAmount, values.installmentCount]);
  const splitTotal = split.reduce((sum, value) => sum + Number(value), 0);

  useEffect(() => {
    if (params.get('investorId')) setValue('investorId', params.get('investorId') ?? '');
  }, [params, setValue]);

  const mutation = useMutation({
    mutationFn: (form: FormValues) =>
      investmentService.create({
        investorId: form.investorId,
        totalAmount: form.totalAmount,
        installmentCount: Number(form.installmentCount),
        firstDueDate: form.firstDueDate,
        interval: { unit: form.intervalUnit, value: Number(form.intervalValue) },
        notes: form.notes,
      }),
    onSuccess: (investment) => {
      toast.success('Investment created');
      navigate(`/investments/${investment.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-5">
      <div>
        <Link to="/investments" className="text-sm text-slate-500 hover:text-slate-700">
          ← Investments
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-slate-900">New investment</h1>
        <p className="text-sm text-slate-500">The total is split into equal installments; any remainder goes to the last installment.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <form
          className="card lg:col-span-2"
          onSubmit={handleSubmit((form) => mutation.mutate(form))}
        >
          <div className="card-body space-y-4">
            <Field label="Investor" error={errors.investorId?.message} hint="Only active investors can receive a new investment">
              <Input placeholder="Type to search investors…" value={investorQuery} onChange={(event) => setInvestorQuery(event.target.value)} className="mb-2" />
              {investors.isLoading ? (
                <Loading label="" />
              ) : (
                <Select {...register('investorId')}>
                  <option value="">Select an investor…</option>
                  {(investors.data?.items ?? []).map((investor) => (
                    <option key={investor.id} value={investor.id}>
                      {investor.name} — {investor.mobileMasked}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Total amount (BDT)" error={errors.totalAmount?.message}>
                <Input inputMode="decimal" placeholder="100000" {...register('totalAmount')} />
              </Field>
              <Field label="Installment count" error={errors.installmentCount?.message}>
                <Input type="number" min={1} max={120} {...register('installmentCount')} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="First due date" error={errors.firstDueDate?.message}>
                <Input type="date" {...register('firstDueDate')} />
              </Field>
              <Field label="Repeat every" error={errors.intervalValue?.message}>
                <Input type="number" min={1} max={60} {...register('intervalValue')} />
              </Field>
              <Field label="Interval" error={errors.intervalUnit?.message}>
                <Select {...register('intervalUnit')}>
                  <option value="MONTH">Month(s)</option>
                  <option value="WEEK">Week(s)</option>
                  <option value="DAY">Day(s)</option>
                  <option value="YEAR">Year(s)</option>
                </Select>
              </Field>
            </div>

            <Field label="Notes (optional)" error={errors.notes?.message}>
              <Input placeholder="Agreement reference, remarks…" {...register('notes')} />
            </Field>

            <div className="flex justify-end gap-2">
              <Link to="/investments" className="btn-secondary">
                Cancel
              </Link>
              <button type="submit" className="btn-primary" disabled={mutation.isPending}>
                {mutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                Create investment
              </button>
            </div>
          </div>
        </form>

        <div className="card h-fit">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Schedule preview</h2>
          </div>
          <div className="card-body">
            {split.length === 0 ? (
              <Alert kind="info">Enter an amount and installment count to preview the split.</Alert>
            ) : (
              <>
                <ul className="max-h-80 space-y-1 overflow-y-auto pr-1 text-sm">
                  {split.map((amount, index) => (
                    <li key={index} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5">
                      <span className="text-slate-500">#{index + 1}</span>
                      <span className="tabular-nums text-slate-800">{bdt(amount)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-sm text-slate-600">
                  Sum: <span className="font-medium">{bdt(splitTotal)}</span> — matches the total exactly (remainder on the last installment).
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
