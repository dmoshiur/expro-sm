import { defineConfig } from 'prisma/config';
import { loadLocalEnvironment } from './src/config/load-local-env';

/**
 * Prisma CLI configuration (Prisma ORM 7).
 *
 * Prisma 7 no longer reads `.env` automatically, so we load it here and hand
 * the connection string to the CLI through `datasource.url`.
 *
 * The CLI only needs a URL for the commands that talk to a database
 * (`prisma migrate *`, `prisma db *`, `prisma studio`). The runtime uses the
 * driver adapter in src/config/prisma.ts instead - and for a remote Turso
 * database the migrations are applied by scripts/apply-migrations.mjs, which
 * speaks libSQL directly (the schema engine cannot dial `libsql://` URLs).
 *
 *   file:./prisma/dev.db      local SQLite file (development / tests)
 *   libsql://<db>.turso.io    remote Turso database
 */
loadLocalEnvironment();

const databaseUrl =
  process.env.TURSO_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'file:./prisma/dev.db';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: databaseUrl },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
