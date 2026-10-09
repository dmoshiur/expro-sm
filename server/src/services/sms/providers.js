/**
 * SMS providers (HTTPS via global fetch only, no SDKs).
 *   console    - development default, logs the message (masked)
 *   bulksmsbd  - Bangladeshi gateway: https://bulksmsbd.net/api/smsapi
 *   generic    - any gateway accepting { api_key, senderid, number, message }
 *
 * The adapter interface is deliberately tiny so a new gateway is one function:
 *   send({ to, message, senderId }) -> { ok, providerMessageId, status, raw }
 */
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { maskMobile } from '../../utils/mask.js';

async function postJson(url, body, { headers = {}, timeoutMs = 15_000, form = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: form
        ? { 'content-type': 'application/x-www-form-urlencoded', ...headers }
        : { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, text: text.slice(0, 800), json };
  } finally {
    clearTimeout(timer);
  }
}

function consoleProvider() {
  return {
    name: 'console',
    async send({ to, message }) {
      logger.info('SMS (console provider)', { to: maskMobile(to), length: message.length, preview: message.slice(0, 90) });
      return { ok: true, status: 'SENT', providerMessageId: `console-${Date.now()}`, raw: { dryRun: true } };
    },
  };
}

function bulkSmsBdProvider() {
  const endpoint = config.sms.apiUrl || 'https://bulksmsbd.net/api/smsapi';
  return {
    name: 'bulksmsbd',
    async send({ to, message }) {
      const payload = {
        api_key: config.sms.apiKey,
        type: 'text',
        number: `88${String(to).replace(/^88/, '')}`,
        senderid: config.sms.senderId || '',
        message,
      };
      const res = await postJson(endpoint, payload, { form: true });
      const ok = res.ok && (!res.json || String(res.json.response_code ?? '202') === '202');
      return {
        ok,
        status: ok ? 'SENT' : 'FAILED',
        providerMessageId: res.json?.message_id ? String(res.json.message_id) : null,
        raw: { httpStatus: res.status, body: res.json ?? res.text },
        error: ok ? null : `Gateway responded ${res.status}`,
      };
    },
  };
}

function genericProvider() {
  const endpoint = config.sms.apiUrl;
  return {
    name: 'generic',
    async send({ to, message }) {
      const res = await postJson(
        endpoint,
        { api_key: config.sms.apiKey, senderid: config.sms.senderId || '', number: to, message },
        { headers: config.sms.apiKey ? { authorization: `Bearer ${config.sms.apiKey}` } : {} },
      );
      const ok = res.ok;
      return {
        ok,
        status: ok ? 'SENT' : 'FAILED',
        providerMessageId: res.json?.id ?? res.json?.message_id ?? null,
        raw: { httpStatus: res.status, body: res.json ?? res.text },
        error: ok ? null : `Gateway responded ${res.status}`,
      };
    },
  };
}

/** In-memory provider used by tests (and runnable as SMS_PROVIDER=memory). */
export function memoryProvider() {
  const sent = [];
  const failed = [];
  let pendingFailure = null;
  return {
    name: 'memory',
    sent,
    failed,
    /** Test helper: make the next send fail (provider outage simulation). */
    failNext(error = 'Simulated provider failure') {
      pendingFailure = error;
    },
    async send({ to, message, messageType = null, installmentId = null, investorId = null }) {
      const entry = { to, message, messageType, installmentId, investorId, at: new Date().toISOString() };
      if (pendingFailure) {
        const error = pendingFailure;
        pendingFailure = null;
        failed.push({ ...entry, error });
        return { ok: false, status: 'FAILED', error, raw: { memory: true, simulated: true } };
      }
      sent.push(entry);
      return { ok: true, status: 'SENT', providerMessageId: `mem-${sent.length}`, raw: { memory: true } };
    },
  };
}

export function createSmsProvider(name = config.sms.provider) {
  switch (String(name).toLowerCase()) {
    case 'bulksmsbd':
      return bulkSmsBdProvider();
    case 'generic':
      return genericProvider();
    case 'console':
    default:
      return consoleProvider();
  }
}
