/**
 * SMS service: templates + delivery + logging.
 *
 * Every attempt (success or failure) is written to `sms_logs`, which is what the
 * admin UI shows and what the reminder job uses to avoid spamming investors.
 */
import type { SmsPurpose } from '../../generated/prisma/client';
import { config } from '../../config';
import { prisma } from '../../config/prisma';
import { logger } from '../../utils/logger';
import { formatBdt } from '../../utils/money';
import { formatDhakaDate } from '../../utils/dates';
import type { SendSmsInput, SmsProvider } from './sms.types';
import { consoleProvider } from './providers/console.provider';
import { bulkSmsBdProvider } from './providers/bulksmsbd.provider';

/** Provider registry - add new gateways here. */
const PROVIDERS: Record<string, SmsProvider> = {
  console: consoleProvider,
  bulksmsbd: bulkSmsBdProvider,
  // `alpha` is an alias used by some deployments for the same HTTP shape
  alpha: { ...bulkSmsBdProvider, name: 'alpha' },
};

let override: SmsProvider | null = null;

export function getSmsProvider(): SmsProvider {
  if (override) return override;
  return PROVIDERS[config.sms.provider] ?? consoleProvider;
}

/** Test helper. */
export function setSmsProvider(provider: SmsProvider | null): void {
  override = provider;
}

export interface SmsDeliveryResult {
  success: boolean;
  provider: string;
  providerMessageId?: string;
  error?: string;
  logId: string;
}

/** Sends one SMS and records the attempt. Never throws. */
export async function sendSms(input: SendSmsInput): Promise<SmsDeliveryResult> {
  const provider = getSmsProvider();

  const log = await prisma.smsLog.create({
    data: {
      investorId: input.investorId ?? null,
      installmentId: input.installmentId ?? null,
      toMobile: input.to,
      body: input.body,
      provider: provider.name,
      purpose: input.purpose,
      status: 'QUEUED',
    },
  });

  // The console provider only writes to the log. In production that would report
  // a delivery that never happened, so the attempt is failed with a clear reason
  // (the caller/UI sees it, and the SMS log records it) instead of silently
  // "sending" nothing. Real providers report their own configuration state.
  const result =
    config.isProd && provider.name === 'console'
      ? {
          provider: provider.name,
          success: false,
          error: 'SMS is not configured on this deployment (SMS_PROVIDER=console)',
        }
      : await provider.send({ to: input.to, body: input.body });

  if (config.isProd && provider.name === 'console') {
    logger.error({ purpose: input.purpose, to: input.to }, 'SMS not sent: no SMS gateway is configured');
  }

  await prisma.smsLog.update({
    where: { id: log.id },
    data: {
      status: result.success ? 'SENT' : 'FAILED',
      providerMessageId: result.providerMessageId ?? null,
      error: result.error ?? null,
      sentAt: result.success ? new Date() : null,
    },
  });

  if (!result.success) {
    logger.warn({ provider: provider.name, purpose: input.purpose, error: result.error }, 'SMS delivery failed');
  }

  return {
    success: result.success,
    provider: provider.name,
    providerMessageId: result.providerMessageId,
    error: result.error,
    logId: log.id,
  };
}

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

export interface PaymentLinkTemplateInput {
  investorName: string;
  installmentSerial: number;
  installmentCount: number;
  amount: bigint;
  dueDate: Date;
  url: string;
  companyName?: string;
}

/**
 * The SMS contains the payment link and the strictly necessary facts. It never
 * contains NID, full account numbers or other personal data.
 */
export function paymentLinkMessage(input: PaymentLinkTemplateInput): string {
  const company = input.companyName ?? 'Investor Portal';
  return [
    `${company}: Dear ${input.investorName}, your installment ${input.installmentSerial}/${input.installmentCount} of ${formatBdt(input.amount)} is due on ${formatDhakaDate(input.dueDate)}.`,
    `Pay securely with bKash: ${input.url}`,
  ].join(' ');
}

export interface ReminderTemplateInput {
  investorName: string;
  installmentSerial: number;
  amount: bigint;
  dueDate: Date;
  url: string;
  overdue: boolean;
  daysOverdue?: number;
  companyName?: string;
}

export function reminderMessage(input: ReminderTemplateInput): string {
  const company = input.companyName ?? 'Investor Portal';
  if (input.overdue) {
    return [
      `${company}: Dear ${input.investorName}, installment ${input.installmentSerial} of ${formatBdt(input.amount)} was due on ${formatDhakaDate(input.dueDate)}`,
      input.daysOverdue ? `(${input.daysOverdue} days overdue)` : '',
      `Please pay with bKash: ${input.url}`,
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    `${company}: Dear ${input.investorName}, a reminder that installment ${input.installmentSerial} of ${formatBdt(input.amount)} is due on ${formatDhakaDate(input.dueDate)}.`,
    `Pay with bKash: ${input.url}`,
  ].join(' ');
}

export function manualMessage(body: string, variables: Record<string, string> = {}): string {
  return body.replace(/\{(\w+)\}/g, (_match, key: string) => variables[key] ?? `{${key}}`);
}

export const smsService = {
  sendSms,
  getSmsProvider,
  setSmsProvider,
  paymentLinkMessage,
  reminderMessage,
  manualMessage,
  PURPOSE: {
    PAYMENT_LINK: 'PAYMENT_LINK' as SmsPurpose,
    REMINDER_DUE: 'REMINDER_DUE' as SmsPurpose,
    REMINDER_OVERDUE: 'REMINDER_OVERDUE' as SmsPurpose,
    MANUAL: 'MANUAL' as SmsPurpose,
    BULK: 'BULK' as SmsPurpose,
  },
};
export default smsService;
