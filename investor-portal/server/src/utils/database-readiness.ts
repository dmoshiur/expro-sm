/**
 * Tables created by `prisma/migrations/20260101000000_init/migration.sql` and
 * the migration runner. Keep this list in sync with that initial migration so
 * `/api/health` verifies schema readiness, not just that a database accepts
 * `SELECT 1`.
 */
export const REQUIRED_DATABASE_TABLES = [
  '_prisma_migrations',
  'admins',
  'refresh_tokens',
  'investors',
  'nominees',
  'investments',
  'installments',
  'payments',
  'audit_logs',
  'sms_logs',
  'settings',
] as const;

export function findMissingDatabaseTables(presentTables: Iterable<string>): string[] {
  const present = new Set(presentTables);
  return REQUIRED_DATABASE_TABLES.filter((table) => !present.has(table));
}
