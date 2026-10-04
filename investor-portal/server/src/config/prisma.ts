/**
 * Prisma client singleton.
 *
 * The app talks to Supabase ONLY through this Express server: no Supabase Auth,
 * no Realtime, no client-side database access. At runtime Prisma connects
 * through the Supavisor/pgbouncer pooler (DATABASE_URL, port 6543);
 * `prisma migrate` uses the direct connection (DIRECT_URL, port 5432).
 *
 * The client is generated with `engineType = "client"`: queries are compiled by
 * the WASM query compiler shipped in @prisma/client and executed over the
 * node-postgres driver adapter. The deployment therefore needs no
 * platform-specific Rust engine binaries while using exactly the same Prisma
 * API, SQL and migration files.
 *
 * Tests swap in TEST_DATABASE_URL so the development database is never touched.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

const globalForPrisma = globalThis as unknown as {
  __prisma?: PrismaClient;
  __pool?: Pool;
};

export const runtimeDatabaseUrl: string =
  config.isTest && config.db.testUrl ? config.db.testUrl : config.db.url;

/**
 * Managed (Supabase) databases require TLS. When the URL asks for SSL we accept
 * the provider certificate chain as-is (managed Postgres rotates its CA);
 * self-hosted Postgres with a private CA should set `sslmode=verify-full` and
 * ship the CA through NODE_EXTRA_CA_CERTS.
 */
function sslFor(url: string): false | { rejectUnauthorized: boolean } {
  const sslmode = /sslmode=([a-z-]+)/i.exec(url)?.[1]?.toLowerCase();
  if (sslmode === 'disable' || sslmode === 'allow') return false;
  if (sslmode) return { rejectUnauthorized: sslmode === 'verify-full' };
  return /localhost|127\.0\.0\.1|::1/.test(url) ? false : { rejectUnauthorized: false };
}

function createPool(): Pool {
  const pool = new Pool({
    connectionString: runtimeDatabaseUrl,
    ssl: sslFor(runtimeDatabaseUrl),
    max: config.isTest ? 5 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
    application_name: 'investor-portal-api',
  });
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
  return pool;
}

function createClient(pool: Pool): PrismaClient {
  const client = new PrismaClient({
    adapter: new PrismaPg(pool),
    log: config.isDev
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  });

  client.$on('warn' as never, (e: Prisma.LogEvent) => logger.warn({ prisma: e }, 'prisma warning'));
  client.$on('error' as never, (e: Prisma.LogEvent) => logger.error({ prisma: e }, 'prisma error'));
  if (config.isDev) {
    client.$on('query' as never, (e: Prisma.QueryEvent) => {
      if (e.duration > 200) logger.debug({ query: e.query, ms: e.duration }, 'slow query');
    });
  }
  return client;
}

export const pool: Pool = globalForPrisma.__pool ?? createPool();
export const prisma: PrismaClient = globalForPrisma.__prisma ?? createClient(pool);

if (!config.isProd) {
  globalForPrisma.__pool = pool;
  globalForPrisma.__prisma = prisma;
}

/** Graceful shutdown: closes the Prisma client and the Postgres pool. */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

/** Transaction client type used by services. */
export type Tx = Prisma.TransactionClient;
export { Prisma };
