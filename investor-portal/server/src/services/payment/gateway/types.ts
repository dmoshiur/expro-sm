/**
 * Payment gateway abstraction.
 *
 * bKash Tokenized Checkout is implemented today; Nagad/card gateways only need
 * to implement this interface and be registered in gateway/index.ts. Nothing in
 * the payment service knows anything about provider-specific payloads.
 */
import type { PaymentGateway } from '../../../generated/prisma/client';

export type GatewayTransactionStatus = 'Initiated' | 'Pending' | 'Completed' | 'Failed' | 'Cancelled' | 'Unknown';

export interface CreatePaymentInput {
  /** amount in poisha */
  amount: bigint;
  /** our unique reference - also stored by the gateway for reconciliation */
  merchantInvoiceNumber: string;
  /** where the gateway should send the investor back to */
  callbackUrl: string;
  /** a stable reference for the payer (we use the FIRST name only) */
  payerReference?: string;
  /** free text shown in the gateway dashboard */
  additionalInfo?: string;
}

export interface CreatedPayment {
  gatewayPaymentId: string;
  /** URL the browser must be redirected to in order to authorise the payment */
  redirectUrl: string | null;
  raw: unknown;
}

export interface GatewayTransaction {
  gatewayPaymentId: string;
  status: GatewayTransactionStatus;
  /** provider transaction id (bKash trxID) - only present once executed */
  trxId: string | null;
  /** amount the provider actually collected, in poisha */
  amount: bigint;
  merchantInvoiceNumber: string | null;
  payerReference: string | null;
  paymentMethod?: string | null;
  raw: unknown;
  rawStatusText: string;
}

export interface GatewayAdapter {
  readonly name: PaymentGateway;
  /** false for the mock/sandbox-without-credentials adapter */
  readonly live: boolean;
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  /** executes (captures) an authorised payment */
  executePayment(gatewayPaymentId: string): Promise<GatewayTransaction>;
  /** read-only status lookup, used by the callback and the reconciliation job */
  queryPayment(gatewayPaymentId: string): Promise<GatewayTransaction>;
  /** optional: refunds, used by the admin tools when supported */
  refund?(gatewayPaymentId: string, amount: bigint, trxId?: string): Promise<{ refunded: boolean; raw: unknown }>;
}

export class GatewayError extends Error {
  public readonly gatewayCode: string | null;
  public readonly statusCode: number | null;
  public readonly raw: unknown;

  constructor(message: string, options: { gatewayCode?: string | null; statusCode?: number | null; raw?: unknown } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.gatewayCode = options.gatewayCode ?? null;
    this.statusCode = options.statusCode ?? null;
    this.raw = options.raw;
  }
}
