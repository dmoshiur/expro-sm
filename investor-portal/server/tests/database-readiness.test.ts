import { describe, expect, it } from 'vitest';
import { findMissingDatabaseTables, REQUIRED_DATABASE_TABLES } from '../src/utils/database-readiness';

describe('database schema readiness', () => {
  it('accepts every table created by the initial migration and migration runner', () => {
    expect(findMissingDatabaseTables(REQUIRED_DATABASE_TABLES)).toEqual([]);
  });

  it('reports missing application tables when a database has not been migrated', () => {
    expect(findMissingDatabaseTables(['_prisma_migrations', 'settings'])).toEqual(
      REQUIRED_DATABASE_TABLES.filter((table) => !['_prisma_migrations', 'settings'].includes(table)),
    );
  });
});
