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

/** Throws an actionable error instead of silently choosing local/dev services. */
export function assertHostedConfiguration(input: HostedConfiguration): void {
  const problems: string[] = [];
  const label = input.isVercel ? 'Vercel' : 'production';
  const remoteDatabaseUrl = input.syncUrl ?? input.databaseUrl;

  if (input.isVercel && input.syncUrl) {
    problems.push('TURSO_SYNC_URL embedded replicas are not supported on Vercel; use the remote Turso URL directly');
  }
  if (!isRemoteLibsqlUrl(remoteDatabaseUrl)) {
    problems.push('TURSO_DATABASE_URL must target a hosted libSQL/Turso database (file: SQLite is development/test only)');
  }
  if (!input.authToken?.trim()) {
    problems.push('TURSO_AUTH_TOKEN is required for the hosted database');
  }

  if (input.storageDriver !== 'cloudinary') {
    problems.push('STORAGE_DRIVER must be "cloudinary"; local filesystem storage is not durable on hosted runtimes');
  }
  if (!input.cloudinaryConfigured) {
    problems.push('CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are required');
  }
  if (!input.bkashConfigured) {
    problems.push('all four BKASH_* credentials are required; the mock payment gateway is development/test only');
  }
  if (!isHttpsUrl(input.bkashBaseUrl)) {
    problems.push('BKASH_BASE_URL must be an absolute https:// URL');
  } else if (input.bkashMode === 'live' && /sandbox/i.test(input.bkashBaseUrl)) {
    problems.push('BKASH_BASE_URL points to the sandbox while BKASH_MODE=live');
  } else if (input.bkashMode === 'sandbox' && !/sandbox/i.test(input.bkashBaseUrl)) {
    problems.push('BKASH_BASE_URL must point to the sandbox while BKASH_MODE=sandbox');
  }

  if (input.smsProvider === 'console') {
    problems.push('SMS_PROVIDER=console is development/test-only; choose a real SMS gateway');
  }
  if (!input.smsConfigured) {
    problems.push('SMS_API_KEY and SMS_API_URL are required for the configured SMS gateway');
  } else if (!isHttpsUrl(input.smsApiUrl)) {
    problems.push('SMS_API_URL must use https:// so gateway credentials are protected in transit');
  }

  if (!input.cookieSecure) {
    problems.push('COOKIE_SECURE must be true when deployed over HTTPS');
  }

  if (input.corsOrigins.length === 0) {
    problems.push('CORS_ORIGINS must contain the deployed frontend origin');
  } else {
    for (const origin of input.corsOrigins) {
      if (!isHttpsOriginPattern(origin)) {
        problems.push(`CORS_ORIGINS contains an invalid/non-HTTPS origin: ${origin}`);
        continue;
      }
      if (origin.includes('*') && !input.isVercelPreview) {
        problems.push('CORS_ORIGINS wildcards are only allowed on Vercel Preview deployments');
      }
    }
  }

  for (const [name, value] of [
    ['APP_BASE_URL', input.appBaseUrl],
    ['API_BASE_URL', input.apiBaseUrl],
    ['BKASH_CALLBACK_URL', input.bkashCallbackUrl],
  ] as const) {
    if (!isHttpsUrl(value)) problems.push(`${name} must be an absolute https:// URL`);
  }

  if (input.isVercel && input.runJobs) {
    problems.push('set RUN_JOBS=false on Vercel; scheduled work must run in a single dedicated worker/cron');
  }

  if (problems.length > 0) {
    throw new Error(`[config] Invalid ${label} configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
}

export const productionConfigUtils = { isRemoteLibsqlUrl, isHttpsUrl, isHttpsOriginPattern };
