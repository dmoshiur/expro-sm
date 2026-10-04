/**
 * Local Bangladeshi gateway adapter (bulksmsbd.net style HTTP API).
 *
 * Most BD gateways expose a similar shape:
 *   GET/POST {SMS_API_URL}?api_key=...&senderid=...&number=8801XXXXXXXXX&message=...
 * and answer with JSON or plain text containing a message id.
 *
 * The implementation is defensive: timeouts, no retries on 4xx, and the raw
 * response is returned so it can be stored on the SMS log.
 */
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import type { SmsMessage, SmsProvider, SmsSendResult } from '../sms.types';

const REQUEST_TIMEOUT_MS = 10_000;

/** 01712345678 -> 8801712345678 (gateways expect the country code) */
export function toGatewayNumber(mobile: string): string {
  const digits = mobile.replace(/[^\d]/g, '');
  if (digits.startsWith('880')) return digits;
  if (digits.startsWith('0')) return `88${digits}`;
  return `880${digits}`;
}

interface BulkSmsBdResponse {
  response_code?: number | string;
  success_message?: string;
  error_message?: string;
  message_id?: string | number;
  [key: string]: unknown;
}

export const bulkSmsBdProvider: SmsProvider = {
  name: 'bulksmsbd',
  get configured() {
    return Boolean(config.sms.apiKey && config.sms.apiUrl);
  },
  async send(message: SmsMessage): Promise<SmsSendResult> {
    if (!this.configured) {
      return { provider: 'bulksmsbd', success: false, error: 'SMS provider is not configured (SMS_API_URL / SMS_API_KEY)' };
    }

    const payload = new URLSearchParams({
      api_key: config.sms.apiKey,
      type: 'text',
      number: toGatewayNumber(message.to),
      senderid: config.sms.senderId,
      message: message.body,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(config.sms.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString(),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: BulkSmsBdResponse | null = null;
      try {
        parsed = JSON.parse(text) as BulkSmsBdResponse;
      } catch {
        // some gateways answer with plain text
      }

      const ok = response.ok && (parsed ? Number(parsed.response_code ?? 202) < 300 : /success|ok/i.test(text));
      const providerMessageId = parsed?.message_id ? String(parsed.message_id) : undefined;

      if (!ok) {
        logger.warn({ status: response.status, text: text.slice(0, 300) }, 'SMS gateway rejected the message');
        return {
          provider: 'bulksmsbd',
          success: false,
          error: parsed?.error_message ?? `Gateway responded with HTTP ${response.status}`,
          raw: parsed ?? text.slice(0, 500),
        };
      }

      return { provider: 'bulksmsbd', success: true, providerMessageId, raw: parsed ?? text.slice(0, 500) };
    } catch (error) {
      const message_ = error instanceof Error ? error.message : 'unknown error';
      logger.error({ err: error }, 'SMS gateway request failed');
      return { provider: 'bulksmsbd', success: false, error: `Request failed: ${message_}` };
    } finally {
      clearTimeout(timer);
    }
  },
};
