/**
 * Central configuration. Loaded once, validated eagerly: the process must fail
 * fast when a required secret is missing or malformed (see assertConfig()).
 *
 * Env files are loaded by Node itself (`node --env-file-if-exists=.env`), so
 * there is no dotenv dependency anywhere in this project.
 */
import { randomBytes } from 'node:crypto';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off', '']);

function str(env, key, fallback = undefined) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return String(raw).trim();
}

function bool(env, key, fallback = false) {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return fallback;
}

function int(env, key, fallback) {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(env, key) {
  return (str(env, key, '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  const nodeEnv = str(env, 'NODE_ENV', 'development');
  const isProd = nodeEnv === 'production';
  const port = int(env, 'PORT', 3000);
  const publicBaseUrl = (str(env, 'PUBLIC_BASE_URL', `http://localhost:${port}`) || '').replace(/\/+$/, '');

  const dbUrl = str(env, 'DATABASE_URL');
  const dbSslMode = (str(env, 'DB_SSL', 'auto') || 'auto').toLowerCase();
  const dbIsLocal = /@(localhost|127\.0\.0\.1|\[::1\])/.test(dbUrl || '');
  const dbSsl = dbSslMode === 'auto' ? !dbIsLocal : TRUTHY.has(dbSslMode);

  const cfg = {
    nodeEnv,
    isProd,
    isTest: nodeEnv === 'test' || bool(env, 'IS_TEST', false),
    port,
    bindHost: str(env, 'BIND_HOST', '0.0.0.0'),
    publicBaseUrl,
    logLevel: (str(env, 'LOG_LEVEL', 'info') || 'info').toLowerCase(),
    maskLogs: bool(env, 'MASK_LOGS', true),
    trustProxy: int(env, 'TRUST_PROXY', 1),
    allowedOrigins: list(env, 'ALLOWED_ORIGINS'),

    db: {
      url: dbUrl,
      ssl: dbSsl,
      sslRejectUnauthorized: bool(env, 'DB_SSL_REJECT_UNAUTHORIZED', false),
      poolMax: int(env, 'DB_POOL_MAX', 10),
      statementTimeoutMs: int(env, 'DB_STATEMENT_TIMEOUT_MS', 15000),
    },

    security: {
      sessionSecret: str(env, 'SESSION_SECRET'),
      encryptionKey: str(env, 'ENCRYPTION_KEY'),
      sessionTtlHours: int(env, 'SESSION_TTL_HOURS', 12),
      sessionRotateAfterMinutes: int(env, 'SESSION_ROTATE_AFTER_MINUTES', 60),
      cookieName: str(env, 'COOKIE_NAME', 'ip_session'),
      // Secure cookies are non-negotiable in production.
      cookieSecure: isProd ? true : bool(env, 'COOKIE_SECURE', false),
      lockoutThreshold: int(env, 'ADMIN_LOCKOUT_THRESHOLD', 5),
      lockoutMinutes: int(env, 'ADMIN_LOCKOUT_MINUTES', 15),
      maxUploadBytes: int(env, 'MAX_UPLOAD_BYTES', 2 * 1024 * 1024),
      rateLimits: {
        login: { windowMs: int(env, 'RATE_LIMIT_LOGIN_WINDOW_MS', 15 * 60_000), max: int(env, 'RATE_LIMIT_LOGIN_MAX', 10) },
        pay: { windowMs: int(env, 'RATE_LIMIT_PAY_WINDOW_MS', 15 * 60_000), max: int(env, 'RATE_LIMIT_PAY_MAX', 30) },
        api: { windowMs: int(env, 'RATE_LIMIT_API_WINDOW_MS', 60_000), max: int(env, 'RATE_LIMIT_API_MAX', 300) },
        // "Pay with bKash" clicks: tight per-IP window, separate from the page limiter.
        payStart: { windowMs: int(env, 'RATE_LIMIT_PAY_START_WINDOW_MS', 60_000), max: int(env, 'RATE_LIMIT_PAY_START_MAX', 10) },
      },
    },

    paymentLink: {
      ttlDays: int(env, 'PAYMENT_LINK_TTL_DAYS', 30),
    },

    payments: {
      provider: (str(env, 'PAYMENT_PROVIDER', 'mock') || 'mock').toLowerCase(),
      webhookEnabled: bool(env, 'PAYMENTS_WEBHOOK_ENABLED', false),
      webhookSecret: str(env, 'PAYMENTS_WEBHOOK_SECRET'),
      reconcileStuckAfterMinutes: int(env, 'RECONCILE_STUCK_AFTER_MINUTES', 15),
      bkash: {
        mode: (str(env, 'BKASH_MODE', 'sandbox') || 'sandbox').toLowerCase(),
        baseUrl: (str(env, 'BKASH_BASE_URL', '') || '').replace(/\/+$/, ''),
        appKey: str(env, 'BKASH_APP_KEY'),
        appSecret: str(env, 'BKASH_APP_SECRET'),
        username: str(env, 'BKASH_USERNAME'),
        password: str(env, 'BKASH_PASSWORD'),
        callbackUrl: str(env, 'BKASH_CALLBACK_URL'),
      },
    },

    sms: {
      provider: (str(env, 'SMS_PROVIDER', 'console') || 'console').toLowerCase(),
      apiUrl: str(env, 'SMS_API_URL'),
      apiKey: str(env, 'SMS_API_KEY'),
      senderId: str(env, 'SMS_SENDER_ID'),
      dryRun: bool(env, 'SMS_DRY_RUN', !isProd),
    },

    jobs: {
      enabled: bool(env, 'JOBS_ENABLED', true),
      overdueAt: str(env, 'JOB_OVERDUE_AT', '00:10'),
      remindersAt: str(env, 'JOB_REMINDERS_AT', '09:00'),
      reconcileEveryMinutes: int(env, 'JOB_RECONCILE_EVERY_MINUTES', 15),
      reminderDaysBefore: int(env, 'REMINDER_DAYS_BEFORE', 3),
      overdueReminderIntervalHours: int(env, 'OVERDUE_REMINDER_INTERVAL_HOURS', 72),
    },

    totp: {
      issuer: str(env, 'TOTP_ISSUER', 'Investor Installment Portal'),
      window: int(env, 'TOTP_WINDOW', 1),
    },
  };

  return cfg;
}

export const config = loadConfig();

/**
 * Validates configuration and returns a list of problems. `server.js` refuses
 * to start when the list is non-empty; tests may opt out of strict checking.
 */
export function validateConfig(cfg = config) {
  const problems = [];
  if (!cfg.db.url) {
    problems.push('DATABASE_URL is required (Supabase/PostgreSQL connection string)');
  }
  if (!cfg.security.sessionSecret || cfg.security.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET is required and must be at least 32 characters');
  }
  const key = cfg.security.encryptionKey;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    problems.push('ENCRYPTION_KEY is required and must be exactly 64 hex characters (32 bytes)');
  }
  if (!/^https?:\/\//.test(cfg.publicBaseUrl || '')) {
    problems.push('PUBLIC_BASE_URL must be an absolute http(s) URL');
  }
  if (cfg.isProd && /^http:\/\//.test(cfg.publicBaseUrl) && !/localhost|127\.0\.0\.1/.test(cfg.publicBaseUrl)) {
    problems.push('PUBLIC_BASE_URL must be https in production (payment links and cookies are secure-only)');
  }
  if (!['mock', 'bkash'].includes(cfg.payments.provider)) {
    problems.push('PAYMENT_PROVIDER must be one of: mock, bkash');
  }
  if (cfg.payments.provider === 'bkash') {
    const b = cfg.payments.bkash;
    for (const [k, v] of Object.entries({
      BKASH_BASE_URL: b.baseUrl,
      BKASH_APP_KEY: b.appKey,
      BKASH_APP_SECRET: b.appSecret,
      BKASH_USERNAME: b.username,
      BKASH_PASSWORD: b.password,
    })) {
      if (!v) problems.push(`${k} is required when PAYMENT_PROVIDER=bkash`);
    }
    if (cfg.payments.bkash.mode === 'live' && !/^https:\/\//.test(cfg.payments.bkash.baseUrl)) {
      problems.push('BKASH_BASE_URL must be https when BKASH_MODE=live');
    }
  }
  if (!['console', 'bulksmsbd', 'generic'].includes(cfg.sms.provider)) {
    problems.push('SMS_PROVIDER must be one of: console, bulksmsbd, generic');
  }
  if (cfg.sms.provider !== 'console' && (!cfg.sms.apiUrl || !cfg.sms.apiKey)) {
    problems.push('SMS_API_URL and SMS_API_KEY are required for non-console SMS providers');
  }
  for (const [name, value] of [['JOB_OVERDUE_AT', cfg.jobs.overdueAt], ['JOB_REMINDERS_AT', cfg.jobs.remindersAt]]) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) problems.push(`${name} must be HH:MM (24h, Asia/Dhaka)`);
  }
  return problems;
}

/** Dev/test helper: produce a throwaway but valid config (never used in prod). */
export function generateDevSecrets() {
  return {
    SESSION_SECRET: randomBytes(48).toString('base64url'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  };
}

/** Re-read config after mutating process.env (used by tests and by `dev`). */
export function reloadConfig(env = process.env) {
  const fresh = loadConfig(env);
  Object.assign(config, fresh);
  return config;
}
