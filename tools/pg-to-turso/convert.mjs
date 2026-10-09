/**
 * Pure conversion helpers for the PostgreSQL -> Turso transfer. No database access:
 * reads CSV files, converts each value to the representation of its TARGET column,
 * and builds the insert batches. Imported by load-turso.mjs and by unit tests.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv.mjs';

export const TABLES = ['admins', 'sessions', 'investors', 'nominees', 'investments', 'installments', 'payments', 'sms_logs', 'audit_logs', 'job_runs'];
export const REQUIRED_MIGRATION = '001_turso_initial_schema.sql';
export const MAX_PARAMS = 900; // stays well under SQLite's variable limit
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_RE = /^([0-9a-fA-F]{2})*$/;
const INT_RE = /^-?\d+$/;
const REAL_RE = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export function fail(message) {
  throw new Error(message);
}

/** Reads and parses every table CSV. Returns Map<table, { header, rows }>. */
export function readExport(dir) {
  const out = new Map();
  for (const table of TABLES) {
    const file = join(dir, `${table}.csv`);
    if (!existsSync(file)) fail(`Missing ${table}.csv in ${dir} (run export-postgres.sh first)`);
    const parsed = parseCsv(readFileSync(file, 'utf8'));
    if (parsed.length === 0) fail(`${table}.csv is empty (expected a header row)`);
    const [header, ...rows] = parsed;
    if (header.some((h) => h === null || h === '')) fail(`${table}.csv has an empty header name`);
    rows.forEach((r, idx) => {
      if (r.length !== header.length) fail(`${table}.csv row ${idx + 2}: ${r.length} fields, header has ${header.length}`);
    });
    out.set(table, { header, rows });
  }
  return out;
}

/** Converts one CSV value to the value the target column stores. Throws on mismatch. */
export function convertValue(value, column, where) {
  if (value === null) return null;
  const type = column.type.toUpperCase();
  const name = column.name;
  if (type.includes('BLOB')) {
    const hex = value.startsWith('\\x') ? value.slice(2) : value;
    if (!HEX_RE.test(hex)) fail(`${where}: ${name} is not hex-encoded bytea`);
    return Buffer.from(hex, 'hex');
  }
  if (type.includes('INT')) {
    if (value === 't' || value === 'true') return 1;
    if (value === 'f' || value === 'false') return 0;
    if (!INT_RE.test(value)) fail(`${where}: ${name} is not an integer ("${value.slice(0, 40)}")`);
    const n = Number(value);
    if (!Number.isSafeInteger(n)) fail(`${where}: ${name} is outside the safe integer range`);
    return n;
  }
  if (type.includes('REAL') || type.includes('NUM')) {
    if (!REAL_RE.test(value)) fail(`${where}: ${name} is not numeric`);
    return Number(value);
  }
  // TEXT
  if (/(_at|_until)$/.test(name) && !TS_RE.test(value)) fail(`${where}: ${name} is not a UTC ISO timestamp ("${value}")`);
  if (/date$/.test(name) && !DATE_RE.test(value)) fail(`${where}: ${name} is not a YYYY-MM-DD date ("${value}")`);
  return value;
}

/** Builds the insert batches for one table. */
export function buildBatches(table, { header, rows }, targetColumns) {
  const byName = new Map(targetColumns.map((c) => [c.name, c]));
  for (const h of header) {
    if (!byName.has(h)) fail(`${table}.csv has column "${h}" that the Turso schema does not have`);
  }
  const cols = header.map((h) => byName.get(h));
  const perBatch = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  const batches = [];
  rows.forEach((row, idx) => {
    const where = `${table}.csv row ${idx + 2}`;
    const values = row.map((v, c) => convertValue(v, cols[c], where));
    const last = batches[batches.length - 1];
    if (!last || last.params.length / cols.length >= perBatch) batches.push({ params: [], count: 0 });
    const b = batches[batches.length - 1];
    b.params.push(...values);
    b.count += 1;
  });
  // Numbered placeholders (?1..?n), as the app's query layer requires.
  const sql = (count) => {
    let k = 0;
    const tuples = Array.from({ length: count }, () => `(${cols.map(() => `?${++k}`).join(', ')})`);
    return `INSERT INTO ${table} (${header.join(', ')}) VALUES ${tuples.join(', ')}`;
  };
  return { cols, batches: batches.map((b) => ({ sql: sql(b.count), params: b.params, count: b.count })) };
}

