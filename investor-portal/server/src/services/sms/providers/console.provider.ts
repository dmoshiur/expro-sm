/**
 * Console provider: development and test default.
 *
 * Messages are written to the log (and to a ring buffer the test suite can
 * assert on) instead of being sent. This keeps local development free of SMS
 * costs and makes the notification flow fully testable.
 */
import { logger } from '../../../utils/logger';
import type { SmsMessage, SmsProvider, SmsSendResult } from '../sms.types';

export interface SentSmsRecord extends SmsMessage {
  providerMessageId: string;
  sentAt: Date;
}

const outbox: SentSmsRecord[] = [];

export const consoleProvider: SmsProvider = {
  name: 'console',
  configured: true,
  async send(message: SmsMessage): Promise<SmsSendResult> {
    const providerMessageId = `console-${Date.now()}-${outbox.length + 1}`;
    outbox.push({ ...message, providerMessageId, sentAt: new Date() });
    logger.info({ to: message.to, body: message.body }, 'SMS (console provider)');
    return { provider: 'console', success: true, providerMessageId, raw: { simulated: true } };
  },
};

/** Test helper: inspect or clear everything the console provider "sent". */
export const consoleOutbox = {
  all: (): SentSmsRecord[] => [...outbox],
  last: (): SentSmsRecord | undefined => outbox.at(-1),
  clear: (): void => {
    outbox.length = 0;
  },
};
