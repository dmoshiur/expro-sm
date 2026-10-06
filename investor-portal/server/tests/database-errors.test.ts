import express from 'express';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middleware/errorHandler';
import { requestId } from '../src/middleware/requestId';
import { isDatabaseSchemaError } from '../src/utils/database-errors';
import { prisma } from './helpers/db';
import { request } from './helpers/http';

describe('database schema errors', () => {
  it('recognizes Prisma missing-table/column codes', () => {
    expect(isDatabaseSchemaError(Object.assign(new Error('missing table'), { code: 'P2021' }))).toBe(true);
    expect(isDatabaseSchemaError(Object.assign(new Error('missing column'), { code: 'P2022' }))).toBe(true);
  });

  it('recognizes libSQL adapter errors without a Prisma code', () => {
    expect(
      isDatabaseSchemaError(
        new Error('Database error. Code: N/A. Message: SQLITE_UNKNOWN: SQLite error: no such table: main.admins'),
      ),
    ).toBe(true);
    expect(isDatabaseSchemaError(new Error('SQLite error: database is locked'))).toBe(false);
  });

  it('recognizes the missing-table error emitted by the real libSQL adapter', async () => {
    let failure: unknown = null;
    try {
      await prisma.$queryRawUnsafe('SELECT 1 FROM "__missing_schema_table_test__"');
    } catch (error) {
      failure = error;
    }

    expect(failure).not.toBeNull();
    expect(isDatabaseSchemaError(failure)).toBe(true);
  });

  it('returns a safe 503 with migration guidance instead of misclassifying the failure as HTTP 400', async () => {
    const app = express();
    app.use(requestId);
    app.get('/login', (_req, _res, next) => {
      next(new Error('Database error. Code: N/A. Message: SQLITE_UNKNOWN: SQLite error: no such table: main.admins'));
    });
    app.use(errorHandler);

    const response = await request(app).get('/login').expect(503);

    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body.error.message).toMatch(/apply pending migrations/i);
    expect(JSON.stringify(response.body)).not.toMatch(/SQLITE_UNKNOWN|main\.admins|stack/i);
  });
});
