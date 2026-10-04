import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { publicService } from '@/services/payment.service';
import { errorMessage } from '@/services/api';
import { bdt, formatDate } from '@/lib/format';
import { Alert, Spinner } from '@/components/ui';

/**
 * Public payment page (/pay/:token).
 *
 * Shows the minimum: first name, investment/installment number, amount and due
 * date. No login, no investor list, no personal data beyond that.
 */
export default function PayPage() {
  const { token = '' } = useParams();

  const config = useQuery({ queryKey: ['public-config'], queryFn: publicService.config, staleTime: 5 * 60_000, retry: false });
  const payment = useQuery({ queryKey: ['public-payment', token], queryFn: () => publicService.payment(token), retry: false });

  const start = useMutation({
    mutationFn: () => publicService.start(token),
    onSuccess: (result) => {
      if (result.redirectUrl) {
        window.location.href = result.redirectUrl;
      }
    },
  });

  const company = config.data?.companyName ?? 'Investor Portal';
  const support = config.data?.supportMobile;

  if (payment.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
        <div className="card w-full max-w-lg p-8 text-center">
          <Spinner className="mx-auto h-8 w-8" />
          <p className="mt-3 text-sm text-slate-500">Loading your payment details…</p>
        </div>
      </div>
    );
  }

  if (payment.error || !payment.data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
        <div className="card w-full max-w-lg p-8 text-center">
          <p className="text-3xl">🔒</p>
          <h1 className="mt-3 text-lg font-semibold text-slate-900">This payment link is not available</h1>
          <p className="mt-2 text-sm text-slate-600">
            The link may have expired or has already been paid. Please contact the office{support ? ` on ${support}` : ''} to get a new link.
          </p>
        </div>
      </div>
    );
  }

  const data = payment.data;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-lg space-y-4">
        <div className="text-center">
          <span className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">৳</span>
          <h1 className="text-lg font-semibold text-slate-900">{company}</h1>
          <p className="text-sm text-slate-500">Secure installment payment</p>
        </div>

        <div className="card">
          <div className="card-body space-y-4">
            <p className="text-sm text-slate-600">
              Dear <strong>{data.firstName}</strong>, you have an installment to pay.
            </p>

            <dl className="divide-y divide-slate-100 rounded-xl border border-slate-100">
              <div className="flex items-center justify-between px-4 py-3">
                <dt className="text-sm text-slate-500">Installment</dt>
                <dd className="text-sm font-medium text-slate-800">
                  {data.installmentSerial} of {data.installmentCount}
                </dd>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <dt className="text-sm text-slate-500">Due date</dt>
                <dd className="text-sm font-medium text-slate-800">{formatDate(data.dueDate)}</dd>
              </div>
              <div className="flex items-center justify-between bg-brand-50 px-4 py-3">
                <dt className="text-sm font-medium text-brand-800">Amount payable</dt>
                <dd className="text-lg font-semibold text-brand-800">{bdt(data.amount)}</dd>
              </div>
            </dl>

            {data.isOverdue ? <Alert kind="warning">This installment is overdue. Please pay as soon as possible.</Alert> : null}
            {start.error ? <Alert kind="error">{errorMessage(start.error)}</Alert> : null}

            <button type="button" className="btn-primary w-full py-3 text-base" disabled={start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? <Spinner className="h-5 w-5" /> : null}
              Pay {bdt(data.amount)} with bKash
            </button>

            <p className="text-center text-xs text-slate-500">
              You will be redirected to bKash to complete the payment. Never share your PIN or OTP with anyone.
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-slate-500">
          Need help?{support ? ` Call ${support}.` : ' Please contact the office.'}
          {config.data?.gatewayMode === 'sandbox' ? ' (Sandbox environment — no real money moves.)' : ''}
        </p>
      </div>
    </div>
  );
}
