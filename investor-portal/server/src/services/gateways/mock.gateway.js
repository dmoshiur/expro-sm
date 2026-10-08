/**
 * Deterministic in-process gateway used when PAYMENT_PROVIDER=mock (the dev
 * default) and by the test-suite. It implements exactly the same adapter
 * interface as the bKash gateway, including the "server re-queries before
 * trusting" behaviour, so the payment flow can be exercised end to end without
 * touching the network.
 *
 * MOCK_PAYMENT_OUTCOME = success | fail | cancel | pending
 */
import { randomBytes } from 'node:crypto';
import { config } from '../../config/index.js';

export class MockGateway {
  constructor(options = {}) {
    this.name = options.name ?? 'mock';
    this.outcome = options.outcome ?? process.env.MOCK_PAYMENT_OUTCOME ?? 'success';
    this.payments = new Map();
  }

  setOutcome(outcome) {
    this.outcome = outcome;
  }

  async getToken() {
    return 'mock-token';
  }

  async createPayment({ amountPoisha, invoiceNumber, callbackUrl, payerReference = 'investor' }) {
    const paymentId = `MOCK${randomBytes(8).toString('hex').toUpperCase()}`;
    const record = {
      paymentID: paymentId,
      merchantInvoiceNumber: invoiceNumber,
      amount: (Number(amountPoisha) / 100).toFixed(2),
      payerReference,
      callbackURL: callbackUrl,
      executeCount: 0,
      executed: null,
      status: 'Initiated',
    };
    this.payments.set(paymentId, record);
    const url = new URL(callbackUrl);
    url.searchParams.set('paymentID', paymentId);
    url.searchParams.set('status', this.outcome);
    return {
      paymentId,
      redirectUrl: url.toString(),
      status: 'Initiated',
      raw: { mock: true, paymentID: paymentId, bkashURL: url.toString(), amount: record.amount },
    };
  }

  /** Simulates the investor finishing (or abandoning) the hosted checkout. */
  async executePayment({ paymentId }) {
    const record = this.payments.get(paymentId);
    if (!record) return { normalized: 'UNKNOWN', rawStatus: 'Invalid payment id', raw: { mock: true }, trxId: null };
    record.executeCount += 1;
    if (this.outcome === 'fail') {
      record.status = 'Failed';
      return {
        normalized: 'FAILED',
        rawStatus: 'Failed',
        trxId: null,
        paymentId,
        invoiceNumber: record.merchantInvoiceNumber,
        amount: null,
        statusMessage: 'Mock failure',
        raw: { mock: true, transactionStatus: 'Failed', errorMessage: 'Insufficient balance (mock)' },
      };
    }
    if (this.outcome === 'cancel') {
      record.status = 'Cancelled';
      return {
        normalized: 'CANCELLED',
        rawStatus: 'Cancelled',
        trxId: null,
        paymentId,
        invoiceNumber: record.merchantInvoiceNumber,
        amount: null,
        statusMessage: 'Mock cancel',
        raw: { mock: true, transactionStatus: 'Cancelled' },
      };
    }
    if (this.outcome === 'pending') {
      return {
        normalized: 'PENDING',
        rawStatus: 'Initiated',
        trxId: null,
        paymentId,
        invoiceNumber: record.merchantInvoiceNumber,
        amount: null,
        statusMessage: 'Mock pending',
        raw: { mock: true, transactionStatus: 'Initiated' },
      };
    }
    // success (execution is idempotent, like bKash)
    if (!record.executed) {
      record.executed = record.forcedTrxId ?? `MOCKTRX${randomBytes(6).toString('hex').toUpperCase()}`;
      record.status = 'Completed';
    }
    return {
      normalized: 'SUCCESS',
      rawStatus: 'Completed',
      trxId: record.executed,
      paymentId,
      invoiceNumber: record.merchantInvoiceNumber,
      amount: Math.round(Number(record.amount) * 100),
      statusMessage: 'Successful',
      raw: { mock: true, transactionStatus: 'Completed', trxID: record.executed, amount: record.amount },
    };
  }

  async queryPayment({ paymentId }) {
    const record = this.payments.get(paymentId);
    if (!record) {
      return { normalized: 'UNKNOWN', rawStatus: 'Not found', raw: { mock: true }, trxId: null };
    }
    if (record.executed) return this.executePayment({ paymentId });
    if (this.outcome === 'pending' && record.executeCount > 0) {
      return {
        normalized: 'PENDING',
        rawStatus: 'Initiated',
        trxId: null,
        paymentId,
        invoiceNumber: record.merchantInvoiceNumber,
        amount: null,
        statusMessage: 'Initiated',
        raw: { mock: true, transactionStatus: 'Initiated' },
      };
    }
    return {
      normalized: 'PENDING',
      rawStatus: record.status,
      trxId: null,
      paymentId,
      invoiceNumber: record.merchantInvoiceNumber,
      amount: null,
      statusMessage: record.status,
      raw: { mock: true, transactionStatus: record.status },
    };
  }

  /** Test helper: force a mismatch amount on execute/query (verification tests). */
  forceAmount(paymentId, amountPoisha) {
    const record = this.payments.get(paymentId);
    if (record) record.amount = (Number(amountPoisha) / 100).toFixed(2);
  }

  /** Test helper: pin the trxId this payment settles with (duplicate-trx tests). */
  forceTrxId(paymentId, trxId) {
    const record = this.payments.get(paymentId);
    if (record) record.forcedTrxId = String(trxId);
  }

  /**
   * Test helper: pretend the investor completed the payment at the gateway
   * without our callback ever arriving (reconciliation tests). bKash's own
   * gateway gets into this state when the browser loses the redirect.
   */
  completeAtGateway(paymentId, { trxId = null } = {}) {
    const record = this.payments.get(paymentId);
    if (!record) return null;
    record.executed = trxId ?? record.executed ?? `MOCKTRX${randomBytes(6).toString('hex').toUpperCase()}`;
    record.status = 'Completed';
    return record.executed;
  }
}

export function createMockGateway(options) {
  return new MockGateway(options);
}
