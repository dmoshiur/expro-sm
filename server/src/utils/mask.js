/** Sensitive-field masking for logs, API responses and SMS logs. */

const SENSITIVE_KEYS = [
  'password',
  'password_hash',
  'passwordhash',
  'current_password',
  'new_password',
  'confirm_password',
  'secret',
  'totp_secret',
  'token',
  'token_hash',
  'pay_token',
  'authorization',
  'cookie',
  'set-cookie',
  'nid',
  'nid_encrypted',
  'nid_hash',
  'nid_last4',
  'nid_scan',
  'api_key',
  'apikey',
  'app_secret',
  'refresh_token',
  'access_token',
];

const MOBILE_RE = /(?:\+?88)?01[3-9]\d{8}/g;
const EMAIL_RE = /([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+)/g;
const NID_RE = /\b\d{10,17}\b/g;

export function isSensitiveKey(key) {
  const k = String(key).toLowerCase().replace(/[^a-z0-9_]/g, '');
  return SENSITIVE_KEYS.some((s) => k === s || k.includes(s));
}

/** 01712345678 -> 0171*****78 (keeps enough for humans, not for abuse). */
export function maskMobile(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 6) return '***';
  const local = digits.slice(-11);
  return `${local.slice(0, 4)}*****${local.slice(-2)}`;
}

export function maskEmail(value) {
  const s = String(value ?? '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  const name = s.slice(0, at);
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(1, name.length - 2))}${s.slice(at)}`;
}

export function maskNid(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/** Free-text scrubber used for log messages and exported diagnostics. */
export function scrubText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(MOBILE_RE, (m) => maskMobile(m))
    .replace(EMAIL_RE, (_m, a, b) => `${a}***${b}`)
    .replace(NID_RE, (m) => maskNid(m));
}

const MAX_DEPTH = 8;

/** Deep-clone a value for logging with sensitive keys replaced by '***'. */
export function maskValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') return scrubText(value.length > 500 ? `${value.slice(0, 500)}...[truncated]` : value);
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => maskValue(v, depth + 1, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? '***' : maskValue(v, depth + 1, seen);
  }
  return out;
}

/** Public investor payload: never leak full identity details over the pay link. */
export function firstNameOnly(name) {
  const clean = String(name ?? '').trim();
  if (!clean) return 'Investor';
  const first = clean.split(/\s+/)[0];
  return first.length > 40 ? `${first.slice(0, 40)}` : first;
}

/** VIEWER role gets masked investor PII in list/detail responses. */
export function maskInvestor(row) {
  if (!row) return row;
  return {
    ...row,
    mobile: maskMobile(row.mobile),
    email: row.email ? maskEmail(row.email) : row.email,
    address: row.address ? '***' : null,
    nid_last4: row.nid_last4 ? `****${String(row.nid_last4).slice(-4)}` : null,
    has_nid: Boolean(row.has_nid),
  };
}

export function maskNominee(row) {
  if (!row) return row;
  return { ...row, mobile: maskMobile(row.mobile) };
}
