/**
 * Type declarations for scripts/lib/invariants.mjs, which is shared by the
 * plain-Node scripts (`npm run db:check`) and by the TypeScript test suite.
 */
export interface InvariantCheck {
  rule: string;
  sql: string;
}

export interface InvariantViolation {
  rule: string;
  entityId: string | null;
  expected: string | null;
  actual: string | null;
}

export declare const INVARIANT_CHECKS: readonly InvariantCheck[];

export declare function findInvariantViolations(
  execute: (sql: string) => Promise<Array<Record<string, unknown>>>,
): Promise<InvariantViolation[]>;
