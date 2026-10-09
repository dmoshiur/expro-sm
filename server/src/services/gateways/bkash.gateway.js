/**
 * bKash Tokenized Checkout adapter (https://developer.bka.sh).
 *
 * API host: sandbox by default, live when BKASH_MODE=live.
 *   POST /token/grant              -> id_token (cached in memory, refreshed)
 *   POST /create                   -> paymentID + bkashURL
 *   POST /execute                  -> trxID + transactionStatus
 *   POST /payment/status           -> authoritative status for reconciliation
 *
 * Everything goes through global fetch. No SDK, no redirect trust: the server
 * always re-executes / re-queries before money is recognised.
 */
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { badGateway, serviceUnavailable } from '../../utils/errors.js';

const TIMEOUT_MS = 20_000;

export class BkashGateway {
  constructor(options = {}) {
    const cfg = config.payments.bkash;
    this.name = 'bkash';
    this.baseUrl = (options.baseUrl ?? cfg.baseUrl).replace(/\/+$/, '');
    this.appKey = options.appKey ?? cfg.appKey;
    this.appSecret = options.appSecret ?? cfg.appSecret;
    this.username = options.username ?? cfg.username;
    this.password = options.password ?? cfg.password;
    this.mode = options.mode ?? cfg.mode;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get isSandbox() {
    return this.mode !== 'live';
  }

  async call(path, { method = 'POST', body, headers = {}, auth = false } = {}) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const finalHeaders = {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-app-key': this.appKey,
      ...headers,
    };
    if (auth) {
      const token = await this.getToken();
      finalHeaders.authorization = token;
      finalHeaders['x-app-key'] = this.appKey;
    }
    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (!res.ok) {
        logger.error('bkash http error', { url, status: res.status, body: redact(text) });
        throw badGateway(`bKash request failed (HTTP ${res.status})`);
      }
      if (json && json.errorCode && String(json.errorCode) !== '0000') {
        logger.warn('bkash api error', { url, errorCode: json.errorCode, errorMessage: json.errorMessage });
      }
      return json ?? { raw: redact(text) };
    } catch (err) {
      if (err?.name === 'AbortError') throw serviceUnavailable('bKash did not respond in time');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** id_token is valid ~1h; refresh 5 minutes early. */
  async getToken({ force = false } = {}) {
    if (!force && this.token && this.tokenExpiresAt > Date.now() + 60_000) return this.token;
    const headers = { username: this.username, password: this.password };
    const res = await this.call('/token/grant', {
      body: { app_key: this.appKey, app_secret: this.appSecret },
      headers,
    });
    if (!res?.id_token) {
      logger.error('bkash grant returned no id_token', { statusCode: res?.statusCode, statusMessage: res?.statusMessage });
      throw badGateway('Could not authenticate with bKash');
    }
    const expiresIn = Number(res.expires_in ?? 3600);
    this.token = res.id_token;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000;
    return this.token;
  }

  async createPayment({ amountPoisha, invoiceNumber, callbackUrl, payerReference = 'investor' }) {
    const body = {
      mode: '0011',
      payerReference: String(payerReference).slice(0, 60),
      callbackURL: callbackUrl,
      amount: (Number(amountPoisha) / 100).toFixed(2),
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: String(invoiceNumber).slice(0, 60),
    };
    const res = await this.call('/create', { body, auth: true });
    if (!res?.paymentID || !res?.bkashURL) {
      throw badGateway('bKash did not return a payment id / redirect URL');
    }
    return { paymentId: res.paymentID, redirectUrl: res.bkashURL, raw: res, status: res.transactionStatus ?? 'Initiated' };
  }

  async executePayment({ paymentId }) {
    const res = await this.call('/execute', { body: { paymentID: paymentId }, auth: true });
    return normalize(res);
  }

  async queryPayment({ paymentId }) {
    const res = await this.call('/payment/status', { body: { paymentID: paymentId }, auth: true });
    return normalize(res);
  }
}

const SUCCESS_STATES = ['Completed', 'Success', 'completed', 'success'];
const FAILED_STATES = ['Failed', 'failed', 'failure'];
const CANCELLED_STATES = ['Cancelled', 'Canceled', 'cancelled', 'canceled', 'Initiated'];

function normalize(res) {
  if (!res || typeof res !== 'object') return { normalized: 'UNKNOWN', raw: res };
  const status = String(res.transactionStatus ?? res.statusMessage ?? '');
  let normalized = 'PENDING';
  if (SUCCESS_STATES.includes(status)) normalized = 'SUCCESS';
  else if (FAILED_STATES.includes(status)) normalized = 'FAILED';
  else if (CANCELLED_STATES.includes(status)) normalized = 'CANCELLED';
  else if (status === '') normalized = 'PENDING';
  return {
    normalized,
    rawStatus: status,
    trxId: res.trxID ?? null,
    paymentId: res.paymentID ?? null,
    invoiceNumber: res.merchantInvoiceNumber ?? null,
    amount: res.amount !== undefined ? Math.round(Number(res.amount) * 100) : null,
    statusCode: res.statusCode ?? null,
    statusMessage: res.statusMessage ? String(res.statusMessage).slice(0, 300) : null,
    raw: res,
  };
}

function redact(text) {
  return String(text ?? '')
    .replace(/"id_token"\s*:\s*"[^"]+"/g, '"id_token":"***"')
    .slice(0, 600);
}

export function createBkashGateway(options) {
  return new BkashGateway(options);
}
