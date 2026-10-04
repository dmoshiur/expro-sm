import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * `engine: 'js'` selects the JavaScript/WASM schema engine: `prisma generate`,
 * `prisma migrate` and `prisma db` talk to PostgreSQL through the node-postgres
 * driver adapter instead of downloading platform-specific Rust binaries.
 * Set PRISMA_ENGINE=classic to use the classic native engine instead.
 */
loadEnv({ path: path.resolve(__dirname, '.env') });

const useClassicEngine = process.env.PRISMA_ENGINE === 'classic';
const databaseUrl =
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5432/investor_portal';

const adapter = async () => {
  const { PrismaPg } = await import('@prisma/adapter-pg');
  return new PrismaPg({ connectionString: databaseUrl });
};

export default defineConfig({
  schema: 'prisma/schema.prisma',
  experimental: {
    // required for the JS schema engine + driver adapters
    adapter: true,
  },
  ...(useClassicEngine
    ? {
        engine: 'classic' as const,
        datasource: { url: databaseUrl, shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL },
      }
    : {
        engine: 'js' as const,
        adapter,
      }),
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
