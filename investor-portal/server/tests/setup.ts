/**
 * Global test setup (referenced by vitest.config.ts).
 *
 * Tests run against a dedicated PostgreSQL database (TEST_DATABASE_URL) that is
 * migrated with `npm run test:db` and truncated between suites. The bKash and
 * SMS providers are replaced by deterministic mocks in tests/harness.ts, so no
 * test ever reaches an external network.
 */
process.env.NODE_ENV = 'test';
process.env.TZ = 'Asia/Dhaka';

// Rate limiting is exercised by a dedicated test that re-imports the app with
// limits enabled; everywhere else it would make the suite flaky (every request
// in a test file shares one client IP).
process.env.RATE_LIMIT_DISABLED = '1';
