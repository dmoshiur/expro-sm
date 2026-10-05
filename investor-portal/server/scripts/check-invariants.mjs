#!/usr/bin/env node
/**
 * Database integrity check (`npm run db:check`).
 *
 * SQLite has no deferred constraint triggers, so two invariants that PostgreSQL
 * checked at COMMIT time cannot live in the schema itself:
 *
 *   1. the installments of an investment must sum to its total amount
 *   2. the nominee shares of an investor must add up to exactly 100
 *
 * Both are validated by the services on every write (`validateNomineeShares`,
 * `updateInvestmentInstallments`) and re-checked here (scripts/lib/invariants.mjs).
 * Run it after a restore, from cron, in CI or before a release - it exits
 * non-zero and prints one line per violation, so it can be wired into monitoring.
 *
 *   node scripts/check-invariants.mjs
 *   node scripts/check-invariants.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { INVARIANT_CHECKS, findInvariantViolations } from './lib/invariants.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

function loadEnvFile() {
  const file = path.join(serverRoot, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        let value = line.slice(index + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return [line.slice(0, index).trim(), value];
      }),
  );
}

const envFile = loadEnvFile();
const url =
  process.env.TURSO_DATABASE_URL ?? process.env.DATABASE_URL ?? envFile.TURSO_DATABASE_URL ?? envFile.DATABASE_URL ?? 'file:./prisma/dev.db';
const authToken = process.env.TURSO_AUTH_TOKEN ?? envFile.TURSO_AUTH_TOKEN;
const asJson = process.argv.includes('--json');

const client = createClient({ url, ...(authToken ? { authToken } : {}) });
let violations = [];

try {
  violations = await findInvariantViolations(async (sql) => (await client.execute(sql)).rows);
} catch (error) {
  console.error('[db:check]', error instanceof Error ? error.message : error);
  process.exit(2);
} finally {
  client.close();
}

if (asJson) {
  console.log(JSON.stringify({ database: url, checked: INVARIANT_CHECKS.length, violations }, null, 2));
} else if (violations.length === 0) {
  console.log(`[db:check] ${INVARIANT_CHECKS.length} invariant(s) verified on ${url} - database is consistent`);
} else {
  console.error(`[db:check] ${violations.length} violation(s) found on ${url}:`);
  for (const violation of violations) {
    console.error(`  - ${violation.rule} | ${violation.entityId} | expected ${violation.expected}, got ${violation.actual}`);
  }
}

process.exit(violations.length === 0 ? 0 : 1);
