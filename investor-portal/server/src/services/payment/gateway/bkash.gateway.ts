/**
 * bKash Tokenized Checkout adapter.
 *
 * Endpoints (sandbox: https://tokenized.sandbox.bka.sh/v1.2.0-beta):
 *   POST /token/grant            username/password -> id_token (cached in memory)
 *   POST /create                 -> paymentID + bkashURL
 *   POST /execute/{paymentID}    -> captures the authorised payment
 *   GET  /payment/query/{paymentID}
 *   POST /payment/refund
 *
 * The token is requested with the merchant's app_key/app_secret and cached until
 * it is about to expire (or a call answers 401, which forces one refresh).
 */
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { bdtToPoisha, poishaToBdt } from '../../../utils/money';
import type {
  CreatePaymentInput,
  CreatedPayment,
  GatewayAdapter,
  GatewayTransaction,
  GatewayTransactionStatus,
} from './types';
import { GatewayError } from './types';

const REQUEST_TIMEOUT_MS = 20_000;
/** refresh the cached token this many seconds before it expires */
const TOKEN_SAFETY_WINDOW_SECONDS = 60;

interface BkashCredentials {
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
  baseUrl: string;
}

interface BkashResponse {
  statusCode?: string;
  statusMessage?: string;
  errorCode?: string;
  errorMessage?: string;
  paymentID?: string;
  bkashURL?: string;
  trxID?: string;
  transactionStatus?: string;
  amount?: string;
  merchantInvoiceNumber?: string;
  payerReference?: string;
  paymentMethod?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: string | number;
  [key: string]: unknown;
}

function toGatewayAmount(amount: bigint): string {
  return poishaToBdt(amount).toFixed(2);
}

function toPoisha(amount: unknown): bigint {
  if (typeof amount === 'number') return bdtToPoisha(amount.toFixed(2));
  if (typeof amount === 'string' && amount.trim() !== '') return bdtToPoisha(amount);
  return 0n;
}

function mapStatus(raw: string | undefined): GatewayTransactionStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'completed':
      return 'Completed';
    case 'initiated':
      return 'Initiated';
    case 'pending':
      return 'Pending';
    case 'failed':
      return 'Failed';
    case 'cancelled':
    case 'canceled':
      return 'Cancelled';
    default:
      return 'Unknown';
  }
}

export function createBkashGateway(credentials: BkashCredentials): GatewayAdapter {
  let cachedToken: { value: string; expiresAt: number } | null = null;

  async function call<T extends BkashResponse>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: Record<string, unknown>; token?: string | null },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${credentials.baseUrl}${path}`, {
        method: init.method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(init.token ? { Authorization: init.token, 'X-APP-Key': credentials.appKey } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: T;
      try {
        payload = JSON.parse(text) as T;
      } catch {
        throw new GatewayError(`bKash returned a non-JSON response (HTTP ${response.status})`, {
          statusCode: response.status,
          raw: text.slice(0, 500),
        });
      }
      if (!response.ok) {
        throw new GatewayError(payload.errorMessage ?? `bKash request failed (HTTP ${response.status})`, {
          gatewayCode: payload.errorCode ?? null,
          statusCode: response.status,
          raw: payload,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      const message = error instanceof Error ? error.message : 'unknown error';
      throw new GatewayError(`bKash request failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Grants (and caches) the bearer token. */
  async function grantToken(force = false): Promise<string> {
    if (!force && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

    const payload = await call<BkashResponse>('/token/grant', {
      method: 'POST',
      body: { app_key: credentials.appKey, app_secret: credentials.appSecret },
    });
    if (!payload.id_token) {
      throw new GatewayError(payload.errorMessage ?? 'bKash did not return a token', {
        gatewayCode: payload.errorCode ?? null,
        raw: payload,
      });
    }
    const expiresIn = Number(payload.expires_in ?? 3600);
    cachedToken = {
      value: payload.id_token,
      expiresAt: Date.now() + Math.max(60, expiresIn - TOKEN_SAFETY_WINDOW_SECONDS) * 1000,
    };
    logger.info({ expiresIn }, 'bKash token granted');
    return cachedToken.value;
  }

  /** Runs an authenticated call, refreshing the token once on 401. */
  async function withToken<T extends BkashResponse>(run: (token: string) => Promise<T>): Promise<T> {
    const token = await grantToken();
    try {
      return await run(token);
    } catch (error) {
      if (error instanceof GatewayError && error.statusCode === 401) {
        logger.warn('bKash token rejected - refreshing once');
        const fresh = await grantToken(true);
        return run(fresh);
      }
      throw error;
    }
  }

  function toTransaction(payload: BkashResponse, fallbackPaymentId: string): GatewayTransaction {
    const transactionStatus = payload.transactionStatus ?? payload.statusCode;
    return {
      gatewayPaymentId: payload.paymentID ?? fallbackPaymentId,
      status: mapStatus(transactionStatus),
      trxId: payload.trxID ?? null,
      amount: toPoisha(payload.amount),
      merchantInvoiceNumber: payload.merchantInvoiceNumber ?? null,
      payerReference: payload.payerReference ?? null,
      paymentMethod: payload.paymentMethod ?? null,
      raw: payload,
      rawStatusText: String(transactionStatus ?? 'unknown'),
    };
  }

  return {
    name: 'BKASH',
    live: config.bkash.mode === 'live',

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      const payload = await withToken((token) =>
        call<BkashResponse>('/create', {
          method: 'POST',
          token,
          body: {
            mode: '0011',
            payerReference: input.payerReference ?? 'investor',
            callbackURL: input.callbackUrl,
            amount: toGatewayAmount(input.amount),
            currency: 'BDT',
            intent: 'sale',
            merchantInvoiceNumber: input.merchantInvoiceNumber,
            ...(input.additionalInfo ? { additionalInfo: input.additionalInfo.slice(0, 250) } : {}),
          },
        }),
      );

      if (!payload.paymentID || !payload.bkashURL) {
        throw new GatewayError(payload.errorMessage ?? 'bKash did not return a payment id', {
          gatewayCode: payload.errorCode ?? null,
          raw: payload,
        });
      }
      return { gatewayPaymentId: payload.paymentID, redirectUrl: payload.bkashURL, raw: payload };
    },

    async executePayment(gatewayPaymentId: string): Promise<GatewayTransaction> {
      const payload = await withToken((token) =>
        call<BkashResponse>(`/execute/${encodeURIComponent(gatewayPaymentId)}`, { method: 'POST', token, body: {} }),
      );
      return toTransaction(payload, gatewayPaymentId);
    },

    async queryPayment(gatewayPaymentId: string): Promise<GatewayTransaction> {
      const payload = await withToken((token) =>
        call<BkashResponse>(`/payment/query/${encodeURIComponent(gatewayPaymentId)}`, { method: 'GET', token }),
      );
      return toTransaction(payload, gatewayPaymentId);
    },

    async refund(gatewayPaymentId: string, amount: bigint, trxId?: string) {
      const payload = await withToken((token) =>
        call<BkashResponse>('/payment/refund', {
          method: 'POST',
          token,
          body: {
            paymentID: gatewayPaymentId,
            amount: toGatewayAmount(amount),
            trxID: trxId ?? '',
            sku: 'installment',
            reason: 'refund requested by admin',
          },
        }),
      );
      const refunded = ['completed', 'success'].includes(String(payload.transactionStatus ?? '').toLowerCase());
      return { refunded, raw: payload };
    },
  };
}
