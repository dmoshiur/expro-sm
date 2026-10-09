/**
 * Normalized database errors. libSQL reports constraint failures with a generic
 * SQLITE_CONSTRAINT code; the extended code and message tell us which kind it is.
 * Services check `err.code` (e.g. 'UNIQUE_VIOLATION') and `err.constraint`; the
 * HTTP layer maps these to status codes in utils/errors.js (fromDbError).
 */

export class DbError extends Error {
  /**
   * @param {string} code  UNIQUE_VIOLATION | FOREIGN_KEY_VIOLATION | NOT_NULL_VIOLATION |
   *                       CHECK_VIOLATION | RAISED | DB_UNAVAILABLE | DB_BUSY | DB_ERROR
   */
  constructor(code, message, { constraint = null, sqliteCode = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DbError';
    this.code = code;
    this.constraint = constraint;
    this.sqliteCode = sqliteCode;
  }
}

const NETWORK_RE = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|getaddrinfo|timed? ?out|UND_ERR/i;

/** Maps any error thrown by @libsql/client into a DbError. Non-database errors pass through unchanged. */
export function mapDbError(err) {
  if (err instanceof DbError) return err;
  const ext = String(err?.extendedCode ?? '');
  const raw = String(err?.code ?? '');
  const message = String(err?.message ?? err ?? 'database error');

  if (raw === 'TRANSACTION_ACTIVE' || raw === 'CLIENT_CLOSED' || raw === 'TRANSACTION_CLOSED') {
    return new DbError('DB_UNAVAILABLE', 'Database connection is not available', { cause: err });
  }
  if (ext.startsWith('SQLITE_CONSTRAINT') || raw === 'SQLITE_CONSTRAINT') {
    const constraint = parseConstraint(message);
    if (ext === 'SQLITE_CONSTRAINT_UNIQUE' || ext === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return new DbError('UNIQUE_VIOLATION', 'Unique constraint violated', { constraint, sqliteCode: ext, cause: err });
    }
    if (ext === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return new DbError('FOREIGN_KEY_VIOLATION', 'Foreign key constraint violated', { sqliteCode: ext, cause: err });
    }
    if (ext === 'SQLITE_CONSTRAINT_NOTNULL') {
      return new DbError('NOT_NULL_VIOLATION', 'A required value is missing', { constraint, sqliteCode: ext, cause: err });
    }
    if (ext === 'SQLITE_CONSTRAINT_CHECK') {
      return new DbError('CHECK_VIOLATION', 'A value violates a data rule', { constraint, sqliteCode: ext, cause: err });
    }
    if (ext === 'SQLITE_CONSTRAINT_TRIGGER') {
      // RAISE(ABORT, '...') messages are written by us in the migrations and are safe to show.
      return new DbError('RAISED', message.replace(/^SQLITE_CONSTRAINT:\s*/, ''), { sqliteCode: ext, cause: err });
    }
    return new DbError('CONSTRAINT_VIOLATION', 'A database constraint was violated', { sqliteCode: ext || raw, cause: err });
  }
  if (raw === 'SQLITE_BUSY' || raw === 'SQLITE_LOCKED' || ext === 'SQLITE_BUSY' || ext === 'SQLITE_LOCKED') {
    return new DbError('DB_BUSY', 'Database is busy, please retry', { sqliteCode: ext || raw, cause: err });
  }
  if (NETWORK_RE.test(message) || NETWORK_RE.test(raw)) {
    return new DbError('DB_UNAVAILABLE', 'Database is unreachable', { cause: err });
  }
  if (err?.name === 'LibsqlError' || raw.startsWith('SQLITE_')) {
    return new DbError('DB_ERROR', 'Database query failed', { sqliteCode: raw || ext || null, cause: err });
  }
  return err;
}

/** "UNIQUE constraint failed: payments.gateway, payments.trx_id" -> "payments.gateway, payments.trx_id" */
export function parseConstraint(message) {
  const m = /(?:UNIQUE|NOT NULL|CHECK|FOREIGN KEY) constraint failed:?\s*(.*)$/i.exec(message);
  return m ? m[1].trim() : null;
}
