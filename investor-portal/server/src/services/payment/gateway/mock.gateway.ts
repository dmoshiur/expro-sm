/**
 * Deterministic in-memory gateway used when bKash credentials are absent
 * (local development, CI) and by the automated test suite.
 *
 * It behaves like bKash Tokenized Checkout: create -> (redirect) -> execute ->
 * query. The outcome of the next "authorisation" can be scripted so that all
 * branches (success, failed, cancelled, amount mismatch, duplicate execution)
 * are testable without touching the network.
 */
import crypto from 'node:crypto';
import { logger } from '../../../utils/logger';
import type {
  CreatePaymentInput,
  CreatedPayment,
  GatewayAdapter,
  GatewayTransaction,
  GatewayTransactionStatus,
} from './types';
import { GatewayError } from './types';

export type MockOutcome = 'completed' | 'failed' | 'cancelled' | 'amount_mismatch';

interface MockPayment {
  gatewayPaymentId: string;
  amount: bigint;
  merchantInvoiceNumber: string;
  payerReference: string | null;
  status: GatewayTransactionStatus;
  trxId: string | null;
  /** set when the test wants the gateway to report a different amount */
  reportedAmount?: bigint;
  executed: boolean;
}

const store = new Map<string, MockPayment>();
let nextOutcome: MockOutcome = 'completed';
let forcedAmount: bigint | null = null;

export const mockGatewayControl = {
  /** scripts the outcome of the next authorisation */
  setOutcome(outcome: MockOutcome): void {
    nextOutcome = outcome;
  },
  /** forces the amount the gateway reports back (for mismatch tests) */
  setReportedAmount(amount: bigint | null): void {
    forcedAmount = amount;
  },
  /** simulates the investor landing on the gateway and authorising */
  authorise(gatewayPaymentId: string, outcome: MockOutcome = 'completed'): void {
    const payment = store.get(gatewayPaymentId);
    if (!payment) throw new Error(`mock payment ${gatewayPaymentId} not found`);
    if (outcome === 'completed') {
      payment.status = 'Completed';
      // a real gateway always hands back a transaction id on completion
      if (!payment.trxId) payment.trxId = `MOCKTRX${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    } else if (outcome === 'failed') payment.status = 'Failed';
    else if (outcome === 'cancelled') payment.status = 'Cancelled';
    else if (outcome === 'amount_mismatch') {
      payment.status = 'Completed';
      if (!payment.trxId) payment.trxId = `MOCKTRX${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      payment.reportedAmount = payment.amount + 100n;
    }
  },
  get(gatewayPaymentId: string): MockPayment | undefined {
    return store.get(gatewayPaymentId);
  },
  reset(): void {
    store.clear();
    nextOutcome = 'completed';
    forcedAmount = null;
  },
};

export function createMockGateway(): GatewayAdapter {
  return {
    name: 'BKASH',
    live: false,

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      const gatewayPaymentId = `MOCKPAY${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      store.set(gatewayPaymentId, {
        gatewayPaymentId,
        amount: input.amount,
        merchantInvoiceNumber: input.merchantInvoiceNumber,
        payerReference: input.payerReference ?? null,
        status: 'Initiated',
        trxId: null,
        executed: false,
      });
      logger.debug({ gatewayPaymentId, amount: input.amount.toString() }, 'mock gateway: payment created');
      return { gatewayPaymentId, redirectUrl: `${input.callbackUrl}?paymentID=${gatewayPaymentId}&status=initiated`, raw: { mock: true } };
    },

    async executePayment(gatewayPaymentId: string): Promise<GatewayTransaction> {
      const payment = store.get(gatewayPaymentId);
      if (!payment) throw new GatewayError('Payment not found at the gateway', { gatewayCode: '2001', raw: { mock: true } });

      if (!payment.executed) {
        payment.executed = true;
        if (nextOutcome === 'failed') payment.status = 'Failed';
        else if (nextOutcome === 'cancelled') payment.status = 'Cancelled';
        else {
          payment.status = 'Completed';
          payment.trxId = `MOCKTRX${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
          if (forcedAmount !== null) payment.reportedAmount = forcedAmount;
        }
      }

      const amount = payment.reportedAmount ?? payment.amount;
      return {
        gatewayPaymentId,
        status: payment.status,
        trxId: payment.trxId,
        amount,
        merchantInvoiceNumber: payment.merchantInvoiceNumber,
        payerReference: payment.payerReference,
        paymentMethod: 'bkash',
        raw: { mock: true, ...payment, amount: amount.toString() },
        rawStatusText: payment.status,
      };
    },

    async queryPayment(gatewayPaymentId: string): Promise<GatewayTransaction> {
      const payment = store.get(gatewayPaymentId);
      if (!payment) throw new GatewayError('Payment not found at the gateway', { gatewayCode: '2001', raw: { mock: true } });
      return {
        gatewayPaymentId,
        status: payment.status,
        trxId: payment.trxId,
        amount: payment.reportedAmount ?? payment.amount,
        merchantInvoiceNumber: payment.merchantInvoiceNumber,
        payerReference: payment.payerReference,
        paymentMethod: 'bkash',
        raw: { mock: true, ...payment },
        rawStatusText: payment.status,
      };
    },

    async refund(gatewayPaymentId: string) {
      const payment = store.get(gatewayPaymentId);
      if (!payment) throw new GatewayError('Payment not found at the gateway', { gatewayCode: '2001' });
      payment.status = 'Cancelled';
      return { refunded: true, raw: { mock: true, gatewayPaymentId } };
    },
  };
}
