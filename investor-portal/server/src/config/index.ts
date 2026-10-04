/**
 * Centralised, validated configuration.
 *
 * Everything the server needs comes from server/.env (never from the client).
 * Importing this module throws immediately if something required is missing,
 * so a misconfigured deployment fails fast instead of at request time.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// .env lives next to this package: <repo>/server/.env
dotenv.config({ path: path.resolve(__dirname, '../../../server/.env') });
dotenv.config(); // fall back to process cwd (useful for tests / PM2 ecosystem files)

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const csv = z
  .string()
  .optional()
  .transform((v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  CORS_ORIGINS: csv,
  API_BASE_URL: z.string().default('http://localhost:4000'),
  APP_BASE_URL: z.string().default('http://localhost:5173'),
  TRUST_PROXY: int(1),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().optional(),
  TEST_DATABASE_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  ENCRYPTION_KEY: z.string().min(16, 'ENCRYPTION_KEY must be at least 16 characters'),
  NID_HASH_PEPPER: z.string().min(16, 'NID_HASH_PEPPER must be at least 16 characters'),
  COOKIE_DOMAIN: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  COOKIE_SECURE: bool(true),
  MAX_LOGIN_ATTEMPTS: int(5),
  LOCKOUT_MINUTES: int(15),

  BKASH_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  BKASH_BASE_URL: z.string().default('https://tokenized.sandbox.bka.sh/v1.2.0-beta'),
  BKASH_APP_KEY: z.string().optional().default(''),
  BKASH_APP_SECRET: z.string().optional().default(''),
  BKASH_USERNAME: z.string().optional().default(''),
  BKASH_PASSWORD: z.string().optional().default(''),
  BKASH_CALLBACK_URL: z.string().default('http://localhost:4000/api/public/payments/bkash/callback'),
  BKASH_WEBHOOK_ENABLED: bool(false),
  BKASH_WEBHOOK_SECRET: z.string().optional().default(''),

  STORAGE_DRIVER: z.enum(['auto', 'cloudinary', 'local']).default('auto'),
  LOCAL_STORAGE_DIR: z.string().default('local-storage'),
  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),
  CLOUDINARY_UPLOAD_FOLDER: z.string().default('investor-portal'),
  CLOUDINARY_SIGNED_URL_TTL: int(300),

  SMS_PROVIDER: z.enum(['console', 'bulksmsbd', 'alpha']).default('console'),
  SMS_SENDER_ID: z.string().default('InvestPortal'),
  SMS_API_KEY: z.string().optional().default(''),
  SMS_API_SECRET: z.string().optional().default(''),
  SMS_API_URL: z.string().optional().default(''),

  PAYMENT_LINK_TTL_DAYS: int(7),
  REMINDER_DAYS_BEFORE: int(3),
  REMINDER_ENABLED: bool(true),
  CRON_TIMEZONE: z.string().default('Asia/Dhaka'),
  CRON_OVERDUE_MARK: z.string().default('5 0 * * *'),
  CRON_REMINDERS: z.string().default('0 9 * * *'),
  CRON_RECONCILE: z.string().default('*/15 * * * *'),
  CRON_TOKEN_CLEANUP: z.string().default('30 2 * * *'),

  LOG_LEVEL: z.string().default('info'),
  BCRYPT_ROUNDS: int(12),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\n[config] Invalid environment configuration:\n${issues}\n`);
  throw new Error('Invalid environment configuration. See .env.example.');
}

const env = parsed.data;
const isProd = env.NODE_ENV === 'production';

export const config = {
  env: env.NODE_ENV,
  isProd,
  isTest: env.NODE_ENV === 'test',
  isDev: env.NODE_ENV === 'development',
  port: env.PORT,
  corsOrigins: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : ['http://localhost:5173'],
  apiBaseUrl: env.API_BASE_URL.replace(/\/$/, ''),
  appBaseUrl: env.APP_BASE_URL.replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY,
  db: {
    url: env.DATABASE_URL,
    directUrl: env.DIRECT_URL,
    testUrl: env.TEST_DATABASE_URL,
  },
  auth: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
    encryptionKey: env.ENCRYPTION_KEY,
    nidHashPepper: env.NID_HASH_PEPPER,
    cookieDomain: env.COOKIE_DOMAIN,
    cookieSecure: env.COOKIE_SECURE,
    maxLoginAttempts: env.MAX_LOGIN_ATTEMPTS,
    lockoutMinutes: env.LOCKOUT_MINUTES,
    bcryptRounds: env.BCRYPT_ROUNDS,
    accessCookieName: 'ip_access',
    refreshCookieName: 'ip_refresh',
  },
  bkash: {
    mode: env.BKASH_MODE,
    baseUrl: env.BKASH_BASE_URL.replace(/\/$/, ''),
    appKey: env.BKASH_APP_KEY,
    appSecret: env.BKASH_APP_SECRET,
    username: env.BKASH_USERNAME,
    password: env.BKASH_PASSWORD,
    callbackUrl: env.BKASH_CALLBACK_URL,
    webhookEnabled: env.BKASH_WEBHOOK_ENABLED,
    webhookSecret: env.BKASH_WEBHOOK_SECRET,
    /** true when real credentials are present (otherwise the mock gateway is used) */
    get configured() {
      return Boolean(env.BKASH_APP_KEY && env.BKASH_APP_SECRET && env.BKASH_USERNAME && env.BKASH_PASSWORD);
    },
  },
  storage: {
    driver: env.STORAGE_DRIVER,
    localDir: env.LOCAL_STORAGE_DIR,
    maxUploadBytes: 2 * 1024 * 1024,
  },
  cloudinary: {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
    folder: env.CLOUDINARY_UPLOAD_FOLDER,
    signedUrlTtl: env.CLOUDINARY_SIGNED_URL_TTL,
    get enabled() {
      return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
    },
  },
  sms: {
    provider: env.SMS_PROVIDER,
    senderId: env.SMS_SENDER_ID,
    apiKey: env.SMS_API_KEY,
    apiSecret: env.SMS_API_SECRET,
    apiUrl: env.SMS_API_URL,
  },
  paymentLink: { ttlDays: env.PAYMENT_LINK_TTL_DAYS },
  reminders: {
    enabled: env.REMINDER_ENABLED,
    daysBefore: env.REMINDER_DAYS_BEFORE,
  },
  cron: {
    timezone: env.CRON_TIMEZONE,
    overdueMark: env.CRON_OVERDUE_MARK,
    reminders: env.CRON_REMINDERS,
    reconcile: env.CRON_RECONCILE,
    tokenCleanup: env.CRON_TOKEN_CLEANUP,
  },
  logLevel: env.LOG_LEVEL,
} as const;

export type AppConfig = typeof config;
export default config;
