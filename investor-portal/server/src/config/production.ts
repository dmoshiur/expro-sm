/**
 * Production deployment guardrails. Local SQLite and local disk are useful for
 * development/tests, but are not durable services on Vercel or production.
 * Keep these checks pure so the policy is easy to test without booting Prisma.
 */
export interface HostedConfiguration {
  isVercel: boolean;
  isVercelPreview: boolean;
  databaseUrl: string;
  syncUrl?: string;
  authToken?: string;
  storageDriver: 'auto' | 'cloudinary' | 'local';
  cloudinaryConfigured: boolean;
  bkashConfigured: boolean;
  bkashMode: 'sandbox' | 'live';
  bkashBaseUrl: string;
  smsProvider: 'console' | 'bulksmsbd' | 'alpha';
  smsConfigured: boolean;
  smsApiUrl: string;
  cookieSecure: boolean;
  corsOrigins: readonly string[];
  appBaseUrl: string;
  apiBaseUrl: string;
  bkashCallbackUrl: string;
  runJobs: boolean;
}

const isRemoteLibsqlUrl = (value: string | undefined): boolean => Boolean(value && /^(?:libsql|https):\/\//i.test(value));

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isHttpsOriginPattern(value: string): boolean {
  if (value === '*' || !/^https:\/\//i.test(value)) return false;
  if (value.includes('*')) {
    // This application only supports a single-label wildcard, never a global
    // wildcard or a wildcard crossing multiple DNS labels.
    if (!/^https:\/\/\*\.[^/*]+$/i.test(value)) return false;
    const normalized = value.replace('*.', 'preview.');
    try {
      const url = new URL(normalized);
      return url.protocol === 'https:' && url.origin === normalized;
    } catch {
      return false;
    }
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

/**
 * Which part of the API a configuration problem blocks.
 *
 * `core`     the database, the auth secrets, cookies or the CORS/browser origin:
 *            nothing can be served safely, so the whole API answers 503.
 * `storage`  uploads only (Cloudinary credentials) - the rest of the portal runs.
 * `payments` the bKash checkout only - the rest of the portal runs.
 * `sms`      payment-link/reminder SMS only - the rest of the portal runs.
 *
 * Keeping the scope on every problem is what lets a half-configured deployment
 * boot and *explain itself* (HTTP 503 with the exact list) instead of crashing
 * the whole serverless function with an opaque FUNCTION_INVOCATION_FAILED.
 */
export type ConfigProblemScope = 'core' | 'storage' | 'payments' | 'sms';

export interface ConfigProblem {
  scope: ConfigProblemScope;
  message: string;
}

/**
 * Pure collector behind {@link assertHostedConfiguration}: returns every
 * production problem with the subsystem it blocks. Never throws, so callers can
 * choose between failing fast (self-hosted boot) and failing closed per feature
 * (serverless: 503 + diagnostics).
 */
export function collectHostedConfigurationProblems(input: HostedConfiguration): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const add = (scope: ConfigProblemScope, message: string) => {
    problems.push({ scope, message });
  };
  const remoteDatabaseUrl = input.syncUrl ?? input.databaseUrl;

  if (input.isVercel && input.syncUrl) {
    add('core', 'TURSO_SYNC_URL embedded replicas are not supported on Vercel; use the remote Turso URL directly');
  }
  if (!isRemoteLibsqlUrl(remoteDatabaseUrl)) {
    add('core', 'TURSO_DATABASE_URL must target a hosted libSQL/Turso database (file: SQLite is development/test only)');
  }
  if (!input.authToken?.trim()) {
    add('core', 'TURSO_AUTH_TOKEN is required for the hosted database');
  }

  if (input.storageDriver !== 'cloudinary') {
    add('storage', 'STORAGE_DRIVER must be "cloudinary"; local filesystem storage is not durable on hosted runtimes');
  }
  if (!input.cloudinaryConfigured) {
    add('storage', 'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are required');
  }
  if (!input.bkashConfigured) {
    add('payments', 'all four BKASH_* credentials are required; the mock payment gateway is development/test only');
  }
  if (!isHttpsUrl(input.bkashBaseUrl)) {
    add('payments', 'BKASH_BASE_URL must be an absolute https:// URL');
  } else if (input.bkashMode === 'live' && /sandbox/i.test(input.bkashBaseUrl)) {
    add('payments', 'BKASH_BASE_URL points to the sandbox while BKASH_MODE=live');
  } else if (input.bkashMode === 'sandbox' && !/sandbox/i.test(input.bkashBaseUrl)) {
    add('payments', 'BKASH_BASE_URL must point to the sandbox while BKASH_MODE=sandbox');
  }

  if (input.smsProvider === 'console') {
    add('sms', 'SMS_PROVIDER=console is development/test-only; choose a real SMS gateway');
  }
  if (!input.smsConfigured) {
    add('sms', 'SMS_API_KEY and SMS_API_URL are required for the configured SMS gateway');
  } else if (!isHttpsUrl(input.smsApiUrl)) {
    add('sms', 'SMS_API_URL must use https:// so gateway credentials are protected in transit');
  }

  if (!input.cookieSecure) {
    add('core', 'COOKIE_SECURE must be true when deployed over HTTPS');
  }

  if (input.corsOrigins.length === 0) {
    add('core', 'CORS_ORIGINS must contain the deployed frontend origin');
  } else {
    for (const origin of input.corsOrigins) {
      if (!isHttpsOriginPattern(origin)) {
        add('core', `CORS_ORIGINS contains an invalid/non-HTTPS origin: ${origin}`);
        continue;
      }
      if (origin.includes('*') && !input.isVercelPreview) {
        add('core', 'CORS_ORIGINS wildcards are only allowed on Vercel Preview deployments');
      }
    }
  }

  for (const [name, value, scope] of [
    ['APP_BASE_URL', input.appBaseUrl, 'core'],
    ['API_BASE_URL', input.apiBaseUrl, 'core'],
    ['BKASH_CALLBACK_URL', input.bkashCallbackUrl, 'payments'],
  ] as const) {
    if (!isHttpsUrl(value)) add(scope, `${name} must be an absolute https:// URL`);
  }

  // RUN_JOBS is intentionally not checked here: in-process cron cannot run in a
  // serverless function, so `config.runJobs` is forced off on Vercel instead of
  // requiring every deployment to remember RUN_JOBS=false.

  return problems;
}

/** Throws an actionable error instead of silently choosing local/dev services. */
export function assertHostedConfiguration(input: HostedConfiguration): void {
  const problems = collectHostedConfigurationProblems(input);
  const label = input.isVercel ? 'Vercel' : 'production';

  if (problems.length > 0) {
    throw new Error(`[config] Invalid ${label} configuration:\n${problems.map((problem) => `  - ${problem.message}`).join('\n')}`);
  }
}

export const productionConfigUtils = { isRemoteLibsqlUrl, isHttpsUrl, isHttpsOriginPattern };
