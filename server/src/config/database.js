/**
 * Turso / libSQL database target rules. Pure functions only (no I/O) so they
 * can be unit-tested and reused by config validation, the client and db:check.
 *
 * Production accepts exactly one kind of target: a remote Turso database
 * (libsql:// or https://) reached with TURSO_AUTH_TOKEN. Local files, in-memory
 * databases and localhost endpoints are refused in production so that a missing
 * or mistyped variable can never silently fall back to an empty database.
 */

const REMOTE_PROTOCOLS = new Set(['libsql:', 'https:']);
const DEV_ONLY_PROTOCOLS = new Set(['http:']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * @param {{url?: string, authToken?: string}} db
 * @param {{isProd: boolean, isTest: boolean}} env
 * @returns {{kind: 'remote'|'file'|'local-http'|null, problems: string[], safeDescription: string}}
 *   `safeDescription` never contains credentials: host only, or the file name.
 */
export function describeDatabaseTarget(db, { isProd, isTest }) {
  const problems = [];
  const raw = (db?.url ?? '').trim();
  const token = (db?.authToken ?? '').trim();

  if (!raw) {
    problems.push(
      'TURSO_DATABASE_URL is required (libsql://<database>-<org>.turso.io). See README "Turso setup".',
    );
    return { kind: null, problems, safeDescription: '(not set)' };
  }
  if (/\s/.test(raw)) {
    problems.push('TURSO_DATABASE_URL must not contain whitespace or line breaks');
    return { kind: null, problems, safeDescription: '(invalid)' };
  }

  // In-memory and file: URLs are local-only. Refuse them outside test/dev.
  if (raw === ':memory:' || raw === 'file::memory:' || raw.startsWith('file::memory')) {
    problems.push('TURSO_DATABASE_URL must not be an in-memory database');
    return { kind: null, problems, safeDescription: '(in-memory)' };
  }
  if (raw.startsWith('file:')) {
    const fileName = raw.slice('file:'.length).split('/').pop() || '';
    if (isProd) {
      problems.push(
        'TURSO_DATABASE_URL must be a remote Turso URL (libsql://...) in production; local file databases are not allowed',
      );
      return { kind: null, problems, safeDescription: '(local file refused)' };
    }
    if (isTest && !/test/i.test(fileName)) {
      problems.push('In test mode the local database file name must contain "test" (disposable database only)');
    }
    return { kind: 'file', problems, safeDescription: `file:${fileName}` };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    problems.push('TURSO_DATABASE_URL is not a valid URL (expected libsql://<database>-<org>.turso.io)');
    return { kind: null, problems, safeDescription: '(invalid)' };
  }

  if (url.username || url.password) {
    problems.push('TURSO_DATABASE_URL must not contain credentials; put the token in TURSO_AUTH_TOKEN');
  }
  if (url.searchParams.has('authToken') || url.searchParams.has('auth_token')) {
    problems.push('TURSO_DATABASE_URL must not carry the auth token; use TURSO_AUTH_TOKEN');
  }
  const host = url.hostname;
  const safeDescription = host || '(no host)';
  const isLocalHost = LOCAL_HOSTS.has(host.toLowerCase());

  if (DEV_ONLY_PROTOCOLS.has(url.protocol)) {
    if (isProd || !isLocalHost) {
      problems.push('http:// database URLs are only accepted for a local development server (not in production)');
      return { kind: null, problems, safeDescription };
    }
    return { kind: 'local-http', problems, safeDescription };
  }
  if (!REMOTE_PROTOCOLS.has(url.protocol)) {
    problems.push('TURSO_DATABASE_URL must start with libsql://, https:// (or file: outside production)');
    return { kind: null, problems, safeDescription };
  }
  if (isProd && isLocalHost) {
    problems.push('TURSO_DATABASE_URL must point to Turso in production, not localhost');
  }
  if (!token) {
    problems.push('TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is a remote Turso URL');
  } else if (/\s/.test(token) || token.length < 20) {
    problems.push('TURSO_AUTH_TOKEN looks malformed (expected the token printed by `turso db tokens create`)');
  }
  return { kind: 'remote', problems, safeDescription };
}

/** Returns sanitized text: removes the URL and token if an upstream message echoes them. */
export function scrubDatabaseSecrets(text, db) {
  let out = String(text ?? '');
  for (const secret of [db?.url, db?.authToken]) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out;
}
