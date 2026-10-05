/**
 * Global test setup (referenced by vitest.config.ts).
 *
 * Tests run against a throwaway Turso/libSQL database: TEST_DATABASE_URL
 * (default `file:./prisma/test.db`) is dropped and re-migrated by
 * `npm test` (scripts/reset-db.mjs) and truncated between suites. The bKash and
 * SMS providers are replaced by deterministic mocks, so no test ever reaches an
 * external network.
 *
 * Every value below is a *test-only* default: real deployments always read
 * server/.env. Providing them here keeps the suite runnable in a clean CI
 * checkout without a .env file.
 */
process.env.NODE_ENV = 'test';
process.env.TZ = 'Asia/Dhaka';

// Rate limiting is exercised by a dedicated test that re-imports the app with
// limits enabled; everywhere else it would make the suite flaky (every request
// in a test file shares one client IP).
process.env.RATE_LIMIT_DISABLED = '1';

// Throwaway database file, re-created on every `npm test`.
process.env.TEST_DATABASE_URL ||= 'file:./prisma/test.db';

// Supertest talks plain http, so the auth cookies must not be Secure-only here
// (production keeps the secure default).
process.env.COOKIE_SECURE ||= 'false';

// Test-only secrets (>= the minimum lengths the config schema enforces).
process.env.JWT_ACCESS_SECRET ||= 'test-only-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET ||= 'test-only-refresh-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY ||= 'test-only-encryption-key-0123456789';
process.env.NID_HASH_PEPPER ||= 'test-only-nid-hash-pepper-0123456789';
