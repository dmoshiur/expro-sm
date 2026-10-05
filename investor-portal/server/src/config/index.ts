/**
 * Centralised, validated configuration.
 *
 * Server configuration is validated at module load. A local server/.env file
 * is loaded for development/self-hosting; Vercel-provided environment variables
 * are used directly. Production rejects local-only service fallbacks.
 */
import { z } from 'zod';
import { loadLocalEnvironment } from './load-local-env';
import { assertHostedConfiguration } from './production';

// Production providers inject environment variables directly. This helper only
// reads a local .env for non-Vercel development/self-hosted processes.
loadLocalEnvironment();

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
  VERCEL_ENV: z.enum(['development', 'preview', 'production']).optional(),
  PORT: int(4000),
  CORS_ORIGINS: csv,
  API_BASE_URL: z.string().default('http://localhost:4000'),
  APP_BASE_URL: z.string().default('http://localhost:5173'),
  TRUST_PROXY: int(1),

  // ------------------------------- Turso (libSQL) ---------------------------
  // Primary connection string. Either a remote Turso URL
  // (`libsql://<db>-<org>.turso.io`) or a local SQLite file (`file:./prisma/dev.db`).
  // TURSO_DATABASE_URL wins; DATABASE_URL is accepted as an alias so existing
  // deployments and platform integrations keep working.
  TURSO_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  /** Required for remote (`libsql://`) databases; create one with `turso db tokens create`. */
  TURSO_AUTH_TOKEN: z.string().optional(),
  /**
   * Optional embedded replica: when set, the URL above must point at a local
   * file and this is the remote Turso database it syncs from. Reads hit the
   * local file (single-digit ms), writes are forwarded to the primary.
   */
  TURSO_SYNC_URL: z.string().optional(),
  /** Embedded replica sync interval in seconds (default 60). */
  TURSO_SYNC_INTERVAL: z.string().optional(),
  /** Optional key encrypting the local replica file at rest. */
  TURSO_ENCRYPTION_KEY: z.string().optional(),
  /** Database used by the Vitest suite (recreated on every `npm test`). */
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
  BKASH_BASE_URL: z.string().optional().default(''),
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
  /**
   * Scheduled jobs run inside the API process (node-cron, Asia/Dhaka).
   * Set RUN_JOBS=false on every instance except one when scaling out, or use
   * JOBS_DISABLED=1 (kept as a deprecated alias for older deployments).
   */
  RUN_JOBS: bool(true),
  JOBS_DISABLED: bool(false),
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
const bkashBaseUrl =
  env.BKASH_BASE_URL.trim() ||
  (env.BKASH_MODE === 'live' ? 'https://tokenized.pay.bka.sh/v1.2.0-beta' : 'https://tokenized.sandbox.bka.sh/v1.2.0-beta');

// ------------------------------- database ----------------------------------
const databaseUrl = env.TURSO_DATABASE_URL ?? env.DATABASE_URL ?? 'file:./prisma/dev.db';
const isRemoteDatabase = /^(libsql|https?|wss?|turso):/i.test(databaseUrl);
const syncUrl = env.TURSO_SYNC_URL && env.TURSO_SYNC_URL.length > 0 ? env.TURSO_SYNC_URL : undefined;

if ((isRemoteDatabase || syncUrl) && !env.TURSO_AUTH_TOKEN) {
  throw new Error(
    '[config] TURSO_AUTH_TOKEN is required for the remote Turso database. ' +
      'Create one with `turso db tokens create <db>` and store it as a secret (never in git).',
  );
}
if (syncUrl && isRemoteDatabase) {
  throw new Error(
    '[config] TURSO_SYNC_URL enables an embedded replica, so TURSO_DATABASE_URL must point at a local file ' +
      '(e.g. file:./prisma/replica.db).',
  );
}
if (syncUrl && !/^(libsql|https):\/\//i.test(syncUrl)) {
  throw new Error('[config] TURSO_SYNC_URL must use a remote libsql:// or https:// URL.');
}

const isVercelDeployment =
  env.VERCEL_ENV === 'production' ||
  env.VERCEL_ENV === 'preview' ||
  (process.env.VERCEL === '1' && env.VERCEL_ENV !== 'development');
const isProd = env.NODE_ENV === 'production' || isVercelDeployment;

if (isProd) {
  assertHostedConfiguration({
    isVercel: isVercelDeployment,
    isVercelPreview: env.VERCEL_ENV === 'preview',
    databaseUrl,
    syncUrl,
    authToken: env.TURSO_AUTH_TOKEN,
    storageDriver: env.STORAGE_DRIVER,
    cloudinaryConfigured: Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET),
    bkashConfigured: Boolean(env.BKASH_APP_KEY && env.BKASH_APP_SECRET && env.BKASH_USERNAME && env.BKASH_PASSWORD),
    bkashMode: env.BKASH_MODE,
    bkashBaseUrl,
    smsProvider: env.SMS_PROVIDER,
    smsConfigured: Boolean(env.SMS_API_KEY && env.SMS_API_URL),
    smsApiUrl: env.SMS_API_URL,
    cookieSecure: env.COOKIE_SECURE,
    corsOrigins: env.CORS_ORIGINS,
    appBaseUrl: env.APP_BASE_URL,
    apiBaseUrl: env.API_BASE_URL,
    bkashCallbackUrl: env.BKASH_CALLBACK_URL,
    runJobs: env.RUN_JOBS && !env.JOBS_DISABLED,
  });
}

export const config = {
  env: isProd ? 'production' : env.NODE_ENV,
  isProd,
  isTest: env.NODE_ENV === 'test',
  isDev: env.NODE_ENV === 'development' && !isProd,
  isVercel: isVercelDeployment,
  port: env.PORT,
  corsOrigins: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : ['http://localhost:5173'],
  apiBaseUrl: env.API_BASE_URL.replace(/\/$/, ''),
  appBaseUrl: env.APP_BASE_URL.replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY,
  db: {
    url: databaseUrl,
    testUrl: env.TEST_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
    isRemote: isRemoteDatabase,
    /** embedded replica configuration (optional) */
    syncUrl,
    syncInterval: env.TURSO_SYNC_INTERVAL ? Number.parseInt(env.TURSO_SYNC_INTERVAL, 10) : 60,
    encryptionKey: env.TURSO_ENCRYPTION_KEY,
    get embeddedReplica() {
      return Boolean(syncUrl);
    },
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
    baseUrl: bkashBaseUrl.replace(/\/$/, ''),
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
  /** true when this process should start the cron jobs */
  get runJobs() {
    return env.RUN_JOBS && !env.JOBS_DISABLED;
  },
  logLevel: env.LOG_LEVEL,
} as const;

/**
 * True when a browser origin may talk to the API (see utils/origin.ts).
 * Exported here so middleware shares one implementation with CORS itself.
 */
export { isOriginAllowed } from '../utils/origin';

export type AppConfig = typeof config;
export default config;
