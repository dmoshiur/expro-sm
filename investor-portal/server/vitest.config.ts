import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // The integration suite shares one PostgreSQL database, so files run
    // sequentially to keep fixtures deterministic.
    fileParallelism: false,
    sequence: { shuffle: false },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    reporters: ['default'],
  },
});
