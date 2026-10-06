/** Prisma and libSQL errors that indicate code/schema drift, not a bad request. */
const PRISMA_SCHEMA_ERROR_CODES = new Set(['P2021', 'P2022']);
const MISSING_SCHEMA_MESSAGE =
  /\bno such (?:table|column)\b|\b(?:table|column)\b.{0,120}\b(?:does not exist|was not found)\b/i;

/**
 * Prisma's libSQL adapter can report an absent table as P2021, or as an
 * adapter/SQLite error with no Prisma code (for example SQLITE_UNKNOWN).
 * Inspect nested causes/meta too, without returning any driver details to the
 * client.
 */
export function isDatabaseSchemaError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);

    const record = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      meta?: unknown;
    };

    if (typeof record.code === 'string' && PRISMA_SCHEMA_ERROR_CODES.has(record.code)) return true;
    if (typeof record.message === 'string' && MISSING_SCHEMA_MESSAGE.test(record.message)) return true;

    if (record.cause !== undefined) pending.push(record.cause);
    if (record.meta !== undefined) pending.push(record.meta);
  }

  return false;
}
