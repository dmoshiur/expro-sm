import { useSearchParams } from 'react-router-dom';

const COPY: Record<string, { icon: string; title: string; body: string }> = {
  success: {
    icon: '✅',
    title: 'Payment successful',
    body: 'Thank you! Your installment has been recorded and a receipt is available from the office. You may close this page.',
  },
  pending: {
    icon: '⏳',
    title: 'Payment is being confirmed',
    body: 'We have not received the final confirmation from bKash yet. This page can be closed — the installment will update automatically once the payment is confirmed. Please do not pay again.',
  },
  failed: {
    icon: '⚠️',
    title: 'Payment could not be completed',
    body: 'The payment was not successful and no money has been taken. You can reopen your payment link and try again, or contact the office for help.',
  },
  cancelled: {
    icon: '🚫',
    title: 'Payment cancelled',
    body: 'You cancelled the payment at bKash. No money has been taken. You can use your payment link again whenever you are ready.',
  },
};

export default function PayResultPage() {
  const [params] = useSearchParams();
  const status = params.get('status') ?? 'failed';
  const copy = COPY[status] ?? COPY.failed;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="card w-full max-w-lg p-8 text-center">
        <p className="text-4xl">{copy.icon}</p>
        <h1 className="mt-3 text-lg font-semibold text-slate-900">{copy.title}</h1>
        <p className="mt-2 text-sm text-slate-600">{copy.body}</p>
        {params.get('paymentId') ? (
          <p className="mt-4 font-mono text-xs text-slate-400">Reference: {params.get('paymentId')}</p>
        ) : null}
      </div>
    </div>
  );
}
