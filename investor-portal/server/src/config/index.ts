/**
 * Centralised, validated configuration.
 *
 * Server configuration is validated at module load. A local server/.env file
 * is loaded for development/self-hosting; Vercel-provided environment variables
 * are used directly. Production rejects local-only service fallbacks.
 *
 * Problem handling: nothing here throws for *missing* settings any more. The
 * problems are collected (with the subsystem they block, see ConfigProblem) and
 * exported as `configProblems`; the app answers HTTP 503 with that exact list
 * instead of the whole serverless function dying with an unhelpful
 * `500 FUNCTION_INVOCATION_FAILED`. `assertHostedConfiguration` still exists for
 * the self-hosted boot path and the unit tests, so the policy itself is
 * unchanged: production never silently falls back to local SQLite, local disk,
 * a console SMS gateway or the mock bKash gateway.
 */
import { z } from 'zod';
import { loadLocalEnvironment } from './load-local-env';
import {
  collectHostedConfigurationProblems,
  productionConfigUtils,
  type ConfigProblem,
} from './production';
import { deploymentOrigin, deploymentOrigins, resolveHostedOrigins, resolveHostedUrl } from './deployment-urls';

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

  // Secrets are required, but collected as configuration problems instead of a
  // hard throw so a deployment can boot and report exactly what is missing
  // (see `configProblems` below). Empty strings are treated as "not set".
  JWT_ACCESS_SECRET: z.string().default(''),
  JWT_REFRESH_SECRET: z.string().default(''),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  ENCRYPTION_KEY: z.string().default(''),
  NID_HASH_PEPPER: z.string().default(''),
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

// Values that are structurally unusable (a bad enum, a non-numeric PORT, ...)
// are reported as `core` problems and re-parsed without them, so one bad value
// degrades to the 503 diagnostic instead of killing the import - the same
// treatment missing settings get.
const invalidEnvironmentProblems: string[] = [];
let parsed = schema.safeParse(process.env);
if (!parsed.success) {
  invalidEnvironmentProblems.push(...parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`));
  const sanitized: NodeJS.ProcessEnv = { ...process.env };
  for (const issue of parsed.error.issues) delete sanitized[String(issue.path[0])];
  const retry = schema.safeParse(sanitized);
  if (!retry.success) {
    // Unreachable in practice: the retry only drops the variables that failed.
    const issues = retry.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`\n[config] Invalid environment configuration:\n${issues}\n`);
    throw new Error('Invalid environment configuration. See .env.example.');
  }
  parsed = retry;
}

const env = parsed.data;
const bkashBaseUrl =
  env.BKASH_BASE_URL.trim() ||
  (env.BKASH_MODE === 'live' ? 'https://tokenized.pay.bka.sh/v1.2.0-beta' : 'https://tokenized.sandbox.bka.sh/v1.2.0-beta');

// ------------------------------- database ----------------------------------
// An env var set to '' (common on Vercel when a key was never given a value) is
// treated as unset, so it can never shadow a real value or produce a bogus URL.
const pick = (...values: Array<string | undefined>): string | undefined =>
  values.map((value) => value?.trim()).find((value): value is string => Boolean(value && value.length > 0));
const databaseUrl = pick(env.TURSO_DATABASE_URL, env.DATABASE_URL) ?? 'file:./prisma/dev.db';
const isRemoteDatabase = /^(libsql|https?|wss?|turso):/i.test(databaseUrl);
const syncUrl = pick(env.TURSO_SYNC_URL);

const isVercelDeployment =
  env.VERCEL_ENV === 'production' ||
  env.VERCEL_ENV === 'preview' ||
  (process.env.VERCEL === '1' && env.VERCEL_ENV !== 'development');
const isProd = env.NODE_ENV === 'production' || isVercelDeployment;

// ------------------------- public URLs on Vercel ----------------------------
// Vercel deployments derive their own origin, so a project that copied
// `http://localhost:...` values from .env.example (or left the URLs unset) still
// produces correct payment links, SMS links and bKash redirects, and its own SPA
// is never rejected by CORS. Non-local values are never rewritten; every
// replacement is reported below so it is visible in the deployment logs.
const deploymentUrlContext = {
  isVercel: isVercelDeployment,
  vercelEnv: env.VERCEL_ENV,
  projectProductionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  deploymentUrl: process.env.VERCEL_URL,
};
const ownOrigins = deploymentOrigins(deploymentUrlContext);
const ownOrigin = deploymentOrigin(deploymentUrlContext);

const appBaseUrl = resolveHostedUrl('APP_BASE_URL', env.APP_BASE_URL, ownOrigin);
const apiBaseUrl = resolveHostedUrl('API_BASE_URL', env.API_BASE_URL, ownOrigin);
const bkashCallbackUrl = resolveHostedUrl(
  'BKASH_CALLBACK_URL',
  env.BKASH_CALLBACK_URL,
  ownOrigin ? `${ownOrigin}/api/public/payments/bkash/callback` : undefined,
);
const corsOrigins = resolveHostedOrigins(env.CORS_ORIGINS, ownOrigins);
const urlResolutionNotes = [
  appBaseUrl.note,
  apiBaseUrl.note,
  bkashCallbackUrl.note,
  ...corsOrigins.notes,
].filter((note): note is string => Boolean(note));

for (const note of urlResolutionNotes) {
  console.warn(`[config] ${note}`);
}

// --------------------------- configuration problems ------------------------
// Collected (never thrown) so the API can answer HTTP 503 with the exact list
// instead of crashing every request. `scope: 'core'` problems block the whole
// API; feature scopes only disable the feature that needs them.
const configProblems: ConfigProblem[] = invalidEnvironmentProblems.map((message) => ({
  scope: 'core' as const,
  message: `invalid environment value - ${message}`,
}));
const addProblem = (scope: ConfigProblem['scope'], message: string): void => {
  configProblems.push({ scope, message });
};

for (const [name, value, minLength] of [
  ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET, 32],
  ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET, 32],
  ['ENCRYPTION_KEY', env.ENCRYPTION_KEY, 16],
  ['NID_HASH_PEPPER', env.NID_HASH_PEPPER, 16],
] as const) {
  if (!value.trim()) addProblem('core', `${name} is required`);
  else if (value.trim().length < minLength) addProblem('core', `${name} must be at least ${minLength} characters`);
}

// Hosted deployments get the database rules below from
// collectHostedConfigurationProblems() with deployment-specific wording; these
// two cover development/self-hosted processes so a misconfigured remote URL is
// still reported outside production.
if (!isProd && (isRemoteDatabase || syncUrl) && !pick(env.TURSO_AUTH_TOKEN)) {
  addProblem(
    'core',
    'TURSO_AUTH_TOKEN is required for the remote Turso database. ' +
      'Create one with `turso db tokens create <db>` and store it as a secret (never in git).',
  );
}
if (!isProd && syncUrl && isRemoteDatabase) {
  addProblem(
    'core',
    'TURSO_SYNC_URL enables an embedded replica, so TURSO_DATABASE_URL must point at a local file ' +
      '(e.g. file:./prisma/replica.db).',
  );
}
if (syncUrl && !/^(libsql|https):\/\//i.test(syncUrl)) {
  addProblem('core', 'TURSO_SYNC_URL must use a remote libsql:// or https:// URL.');
}

if (isProd) {
  configProblems.push(
    ...collectHostedConfigurationProblems({
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
      corsOrigins: corsOrigins.origins,
      appBaseUrl: appBaseUrl.value,
      apiBaseUrl: apiBaseUrl.value,
      bkashCallbackUrl: bkashCallbackUrl.value,
      runJobs: env.RUN_JOBS && !env.JOBS_DISABLED,
    }),
  );
}

/**
 * False when this process must not open a database at all: production without a
 * hosted Turso URL/token (never fall back to a local file on a hosted runtime).
 * `src/config/prisma.ts` refuses to build a client in that case.
 */
const hostedDatabaseReady =
  productionConfigUtils.isRemoteLibsqlUrl(syncUrl ?? databaseUrl) &&
  Boolean(pick(env.TURSO_AUTH_TOKEN)) &&
  !(isVercelDeployment && Boolean(syncUrl));
const databaseConfigured = !isProd || hostedDatabaseReady;

// CONFIG_PROBLEMS_SILENT is only set by tooling that prints the problems in its
// own format (`npm --workspace server run env:check`), never by the server.
if (configProblems.length > 0 && process.env.CONFIG_PROBLEMS_SILENT !== '1') {
  // One clear block at cold start; the same list is returned by the API (503)
  // and shown by `npm --workspace server run env:check`.
  console.error(
    `\n[config] This deployment is missing ${configProblems.length} required setting(s):\n` +
      `${configProblems.map((problem) => `  - [${problem.scope}] ${problem.message}`).join('\n')}\n` +
      (configProblems.some((problem) => problem.scope === 'core')
        ? '[config] Requests will receive HTTP 503 until the core settings above are provided.\n'
        : '[config] The API will run; only the features listed above are disabled.\n'),
  );
}

export const config = {
  env: isProd ? 'production' : env.NODE_ENV,
  isProd,
  isTest: env.NODE_ENV === 'test',
  isDev: env.NODE_ENV === 'development' && !isProd,
  isVercel: isVercelDeployment,
  port: env.PORT,
  corsOrigins: corsOrigins.origins.length ? corsOrigins.origins : ['http://localhost:5173'],
  apiBaseUrl: apiBaseUrl.value.replace(/\/$/, ''),
  appBaseUrl: appBaseUrl.value.replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY,
  db: {
    url: databaseUrl,
    testUrl: env.TEST_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
    isRemote: isRemoteDatabase,
    /** false when this process must not open a database (see `hostedDatabaseReady`) */
    configured: databaseConfigured,
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
    callbackUrl: bkashCallbackUrl.value,
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
  /**
   * true when this process should start the cron jobs.
   *
   * In-process node-cron cannot survive in a serverless function (the process is
   * frozen between requests), so jobs are always off on Vercel - no RUN_JOBS
   * setting required. Self-hosted deployments keep RUN_JOBS=true in exactly one
   * process and RUN_JOBS=false in the rest.
   */
  get runJobs() {
    return env.RUN_JOBS && !env.JOBS_DISABLED && !isVercelDeployment;
  },
  logLevel: env.LOG_LEVEL,
} as const;

/**
 * Every missing/invalid production setting with the subsystem it blocks.
 * `scope: 'core'` problems make the API answer HTTP 503 (never a bare 500);
 * feature scopes (storage/payments/sms) disable only that feature.
 */
export { configProblems };
export type { ConfigProblem } from './production';

/**
 * True when a browser origin may talk to the API (see utils/origin.ts).
 * Exported here so middleware shares one implementation with CORS itself.
 */
export { isOriginAllowed } from '../utils/origin';

export type AppConfig = typeof config;
export default config;
