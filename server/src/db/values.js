/**
 * Value conversion between the application (PostgreSQL-shaped JS values) and
 * SQLite storage, plus parameter/placeholder validation. Pure functions.
 *
 * Storage conventions (see migrations/001_initial_schema.sql):
 *  - timestamps: TEXT, UTC ISO-8601 with milliseconds ('2026-10-09T05:41:57.649Z').
 *  - dates: TEXT 'YYYY-MM-DD' (no conversion needed).
 *  - booleans: INTEGER 0/1 (converted on read by column name).
 *  - money: INTEGER poisha, never REAL.
 *  - json: TEXT (parsed on read by column name).
 *  - bytea: BLOB (returned as Buffer).
 */

/** Columns that hold booleans in the schema or in SELECT aliases. */
export const BOOLEAN_COLUMNS = new Set([
  'is_active',
  'totp_enabled',
  'must_change_password',
  'has_nid',
  'has_photo',
  'has_nid_scan',
  'pay_link_active',
]);

/** Columns that hold JSON text. */
export const JSON_COLUMNS = new Set(['old_value', 'new_value', 'meta', 'raw_response', 'detail', 'payload']);

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** Timestamp columns are named *_at, plus admins.locked_until. Dates ('YYYY-MM-DD') are NOT timestamps. */
export function isTimestampColumn(name) {
  return name.endsWith('_at') || name === 'locked_until';
}

/** Converts a value read from libSQL into the shape PostgreSQL (pg) used to return. */
export function fromDbValue(column, value) {
  if (value === null || value === undefined) return null;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value) && !Buffer.isBuffer(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (BOOLEAN_COLUMNS.has(column) && (typeof value === 'number' || typeof value === 'bigint')) {
    return Number(value) !== 0;
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`Column ${column} holds an integer outside the safe range`);
    }
    return Number(value);
  }
  if (typeof value === 'string') {
    if (JSON_COLUMNS.has(column)) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    if (isTimestampColumn(column) && ISO_UTC_RE.test(value)) return new Date(value);
  }
  return value;
}

/** Converts an application parameter into a libSQL argument. */
export function toDbArg(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Invalid Date parameter');
    return value.toISOString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite number parameter');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new RangeError('Integer parameter outside the safe range (money is stored as integer poisha)');
    }
    return value;
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError('BigInt parameter outside the safe range');
    }
    return Number(value);
  }
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  throw new TypeError(`Unsupported parameter type: ${typeof value}`);
}

/** Removes string literals and comments so placeholder scanning ignores them. */
export function stripLiteralsAndComments(sql) {
  return String(sql)
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Enforces that SQL uses ?1..?n placeholders and that every argument is referenced.
 * Rejects leftover PostgreSQL $n placeholders so a missed conversion fails loudly.
 * @returns {number} the number of parameters checked
 */
export function assertPlaceholders(sql, args) {
  const scanned = stripLiteralsAndComments(sql);
  if (/\$\d+/.test(scanned)) {
    throw new Error('PostgreSQL-style $n placeholder found in SQL; use ?n (SQLite) placeholders');
  }
  const used = new Set([...scanned.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
  for (let i = 1; i <= args.length; i += 1) {
    if (!used.has(i)) {
      throw new Error(`SQL parameter ?${i} is passed but not used (expected ${args.length} parameters)`);
    }
  }
  for (const idx of used) {
    if (idx < 1 || idx > args.length) {
      throw new Error(`SQL references ?${idx} but only ${args.length} parameters were passed`);
    }
  }
  return args.length;
}

/** Converts a libSQL row (array-like with names) to a plain object with normalized values. */
export function rowToObject(row, columns) {
  const out = {};
  for (let i = 0; i < columns.length; i += 1) {
    out[columns[i]] = fromDbValue(columns[i], row[i]);
  }
  return out;
}
