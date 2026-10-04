/**
 * Runtime settings (super admin only).
 *
 * Settings live in the `settings` table so an operator can change link expiry
 * or reminder lead time without a redeploy. Environment variables remain the
 * fallback: a missing/invalid row never breaks a job.
 *
 * Only the keys listed in DEFAULTS may be written - the table is not a generic
 * key/value store for arbitrary data.
 */
import { prisma } from '../../config/prisma';
import { config } from '../../config';
import { AuditAction, AuditEntity } from '../../utils/auditActions';
import { recordAudit, type AuditContext } from '../audit/audit.service';
import { badRequest } from '../../utils/errors';
import { logger } from '../../utils/logger';

export const SETTING_KEYS = {
  paymentLinkTtlDays: 'payment_link_ttl_days',
  reminderDaysBefore: 'reminder_days_before',
  companyName: 'company_name',
  receiptPrefix: 'receipt_prefix',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

interface SettingDefinition {
  key: SettingKey;
  label: string;
  description: string;
  type: 'number' | 'string';
  min?: number;
  max?: number;
  /** value used when neither the setting nor the environment provides one */
  fallback: () => string;
}

export const SETTINGS: SettingDefinition[] = [
  {
    key: SETTING_KEYS.paymentLinkTtlDays,
    label: 'Payment link validity (days)',
    description: 'How long a newly generated payment link stays valid before it expires.',
    type: 'number',
    min: 1,
    max: 90,
    fallback: () => String(config.paymentLink.ttlDays),
  },
  {
    key: SETTING_KEYS.reminderDaysBefore,
    label: 'Reminder lead time (days)',
    description: 'Send the "due soon" SMS this many days before the due date.',
    type: 'number',
    min: 0,
    max: 30,
    fallback: () => String(config.reminders.daysBefore),
  },
  {
    key: SETTING_KEYS.companyName,
    label: 'Company name',
    description: 'Shown on the public payment page and in SMS messages.',
    type: 'string',
    fallback: () => process.env.COMPANY_NAME ?? 'Investor Installment Portal',
  },
  {
    key: SETTING_KEYS.receiptPrefix,
    label: 'Receipt number prefix',
    description: 'Prefix used when generating receipt numbers (for example RC-202610-1A2B3C).',
    type: 'string',
    fallback: () => process.env.RECEIPT_PREFIX ?? 'RC',
  },
];

const byKey = new Map(SETTINGS.map((definition) => [definition.key, definition]));

export function isSettingKey(key: string): key is SettingKey {
  return byKey.has(key as SettingKey);
}

/** Reads a single setting with the environment fallback applied. */
export async function getSetting(key: SettingKey): Promise<string> {
  const definition = byKey.get(key);
  if (!definition) throw badRequest(`Unknown setting: ${key}`);
  const row = await prisma.setting.findUnique({ where: { key } });
  const value = row?.value ?? definition.fallback();
  return definition.type === 'number' ? String(Number(value)) : value;
}

export async function getNumberSetting(key: SettingKey): Promise<number> {
  const definition = byKey.get(key);
  if (!definition) throw badRequest(`Unknown setting: ${key}`);
  const value = Number(await getSetting(key));
  if (!Number.isFinite(value)) return Number(definition.fallback());
  if (definition.min !== undefined && value < definition.min) return definition.min;
  if (definition.max !== undefined && value > definition.max) return definition.max;
  return Math.trunc(value);
}

/** All settings with metadata for the admin UI. */
export async function listSettings() {
  const rows = await prisma.setting.findMany();
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  return SETTINGS.map((definition) => ({
    key: definition.key,
    label: definition.label,
    description: definition.description,
    type: definition.type,
    min: definition.min,
    max: definition.max,
    defaultValue: definition.fallback(),
    value: stored.get(definition.key) ?? definition.fallback(),
    isOverridden: stored.has(definition.key),
  }));
}

export async function updateSettings(input: Record<string, string | number>, actor: AuditContext) {
  const entries = Object.entries(input);
  if (entries.length === 0) throw badRequest('No settings supplied');

  const updates: Array<{ key: SettingKey; value: string }> = [];
  for (const [key, rawValue] of entries) {
    if (!isSettingKey(key)) throw badRequest(`Unknown setting: ${key}`);
    const definition = byKey.get(key)!;
    let value = String(rawValue).trim();
    if (definition.type === 'number') {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) throw badRequest(`${definition.label} must be a number`);
      if (definition.min !== undefined && numeric < definition.min) throw badRequest(`${definition.label} must be at least ${definition.min}`);
      if (definition.max !== undefined && numeric > definition.max) throw badRequest(`${definition.label} must be at most ${definition.max}`);
      value = String(Math.trunc(numeric));
    } else if (value.length === 0 || value.length > 120) {
      throw badRequest(`${definition.label} must be between 1 and 120 characters`);
    }
    updates.push({ key: key as SettingKey, value });
  }

  const before = await prisma.setting.findMany({ where: { key: { in: updates.map((update) => update.key) } } });
  const previous = new Map(before.map((row) => [row.key, row.value]));

  await prisma.$transaction(
    updates.map((update) =>
      prisma.setting.upsert({ where: { key: update.key }, update: { value: update.value }, create: { key: update.key, value: update.value } }),
    ),
  );

  for (const update of updates) {
    await recordAudit(actor, {
      action: AuditAction.SETTING_UPDATED,
      entity: AuditEntity.SETTING,
      entityId: update.key,
      oldValue: { value: previous.get(update.key) ?? null },
      newValue: { value: update.value },
    });
  }

  logger.info({ keys: updates.map((update) => update.key), by: actor.adminId }, 'settings updated');
  return listSettings();
}

export const settingsService = { getSetting, getNumberSetting, listSettings, updateSettings, SETTINGS, SETTING_KEYS };
export default settingsService;
