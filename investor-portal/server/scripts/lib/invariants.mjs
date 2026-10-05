/**
 * Database invariants that the SQLite/Turso schema cannot express declaratively.
 *
 * PostgreSQL enforced these with DEFERRED CONSTRAINT TRIGGERS (checked at
 * COMMIT time, which is what allowed a multi-statement edit inside one
 * transaction). SQLite has no deferred triggers, so the services validate every
 * write up-front and this module double-checks the stored data afterwards.
 *
 * Shared by:
 *   - scripts/check-invariants.mjs   (`npm run db:check`, cron, pre-release)
 *   - tests/integrity.test.ts        (the suite asserts the checker itself works)
 *
 * `execute(sql)` must return an array of row objects.
 */

export const INVARIANT_CHECKS = [
  {
    rule: 'installments.sum(amount) == investments.totalAmount',
    sql: `
      SELECT i."id" AS entityId, i."totalAmount" AS expected, COALESCE(SUM(s."amount"), 0) AS actual
      FROM "investments" i
      LEFT JOIN "installments" s ON s."investmentId" = i."id"
      GROUP BY i."id"
      HAVING COALESCE(SUM(s."amount"), 0) <> i."totalAmount"`,
  },
  {
    rule: 'installments.paidAmount <= payments.sum(amount) [SUCCESS only]',
    sql: `
      SELECT s."id" AS entityId, s."paidAmount" AS expected, COALESCE(SUM(p."amount"), 0) AS actual
      FROM "installments" s
      LEFT JOIN "payments" p ON p."installmentId" = s."id" AND p."status" = 'SUCCESS'
      GROUP BY s."id"
      HAVING COALESCE(SUM(p."amount"), 0) < s."paidAmount"`,
  },
  {
    rule: 'nominees.sum(sharePercent) == 100 when an investor has nominees',
    sql: `
      SELECT n."investorId" AS entityId, 100 AS expected, SUM(n."sharePercent") AS actual
      FROM "nominees" n
      GROUP BY n."investorId"
      HAVING SUM(n."sharePercent") <> 100`,
  },
  {
    rule: 'nominees.count <= 3 per investor',
    sql: `
      SELECT n."investorId" AS entityId, 3 AS expected, COUNT(*) AS actual
      FROM "nominees" n
      GROUP BY n."investorId"
      HAVING COUNT(*) > 3`,
  },
  {
    rule: 'installments.paidAmount <= installments.amount',
    sql: 'SELECT "id" AS entityId, "amount" AS expected, "paidAmount" AS actual FROM "installments" WHERE "paidAmount" > "amount"',
  },
  {
    rule: 'money columns are positive 64-bit integers (integer poisha, never a float)',
    sql: `
      SELECT "id" AS entityId, 'investments.totalAmount' AS expected, "totalAmount" AS actual
        FROM "investments" WHERE "totalAmount" <= 0 OR typeof("totalAmount") <> 'integer'
      UNION ALL
      SELECT "id", 'installments.amount', "amount" FROM "installments"
        WHERE "amount" <= 0 OR typeof("amount") <> 'integer'
      UNION ALL
      SELECT "id", 'installments.paidAmount', "paidAmount" FROM "installments"
        WHERE "paidAmount" < 0 OR typeof("paidAmount") <> 'integer'
      UNION ALL
      SELECT "id", 'payments.amount', "amount" FROM "payments"
        WHERE "amount" <= 0 OR typeof("amount") <> 'integer'`,
  },
  {
    rule: 'no orphaned child rows (foreign keys enforced)',
    sql: `
      SELECT 'installments' AS entityId, "id" AS expected, "investmentId" AS actual FROM "installments"
        WHERE "investmentId" NOT IN (SELECT "id" FROM "investments")
      UNION ALL
      SELECT 'payments', "id", "installmentId" FROM "payments" WHERE "installmentId" NOT IN (SELECT "id" FROM "installments")
      UNION ALL
      SELECT 'nominees', "id", "investorId" FROM "nominees" WHERE "investorId" NOT IN (SELECT "id" FROM "investors")
      UNION ALL
      SELECT 'investments', "id", "investorId" FROM "investments" WHERE "investorId" NOT IN (SELECT "id" FROM "investors")`,
  },
];

/**
 * Runs every check and returns the violations it found.
 *
 * @param {(sql: string) => Promise<Array<Record<string, unknown>>>} execute
 */
export async function findInvariantViolations(execute) {
  const violations = [];
  for (const check of INVARIANT_CHECKS) {
    const rows = await execute(check.sql);
    for (const row of rows) {
      violations.push({
        rule: check.rule,
        entityId: row.entityId === null || row.entityId === undefined ? null : String(row.entityId),
        expected: row.expected === null || row.expected === undefined ? null : String(row.expected),
        actual: row.actual === null || row.actual === undefined ? null : String(row.actual),
      });
    }
  }
  return violations;
}
