/**
 * SMS provider abstraction.
 *
 * Adding a new gateway means implementing this interface and registering it in
 * providers/index.ts - nothing else in the codebase changes.
 */
import type { SmsPurpose } from '../../generated/prisma/client';

export interface SmsMessage {
  /** E.164 or local BD format; providers normalise it themselves */
  to: string;
  body: string;
}

export interface SmsSendResult {
  provider: string;
  success: boolean;
  providerMessageId?: string;
  error?: string;
  /** raw provider payload, stored on the SMS log for support/debugging */
  raw?: unknown;
}

export interface SmsProvider {
  readonly name: string;
  /** true when the provider has everything it needs from the environment */
  readonly configured: boolean;
  send(message: SmsMessage): Promise<SmsSendResult>;
}

export interface SendSmsInput extends SmsMessage {
  purpose: SmsPurpose;
  investorId?: string | null;
  installmentId?: string | null;
  /** admin who triggered the send (null for jobs) */
  sentByAdminId?: string | null;
}
