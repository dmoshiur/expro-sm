/**
 * Prisma client singleton for Turso (libSQL).
 *
 * The whole app talks to the database through this module. Turso speaks SQLite
 * over libSQL, so the client runs on the official `@prisma/adapter-libsql`
 * driver adapter with `intMode: 'bigint'`:
 *
 *   - `intMode: 'bigint'`  every INTEGER comes back as a JS bigint, so the money
 *     rule (integer poisha, never a float) holds even above 2^53 and Prisma's
 *     BigInt columns round-trip exactly. Int columns stay JS numbers.
 *   - ISO-8601 timestamps  DateTime columns are stored as UTC text
 *     ('2026-01-31T10:00:00.000+00:00'), which keeps raw SQL simple - e.g.
 *     `strftime('%Y-%m', "completedAt", '+6 hours')` is the Asia/Dhaka month.
 *
 * Deployment shapes, all through the same code path:
 *
 *   1. Local development / tests   TURSO_DATABASE_URL=file:./prisma/dev.db
 *   2. Vercel / containers / VPS   TURSO_DATABASE_URL=libsql://<db>.turso.io
 *                                  TURSO_AUTH_TOKEN=<token>
 *   3. Embedded replica (low latency reads, writes still reach the primary):
 *                                  TURSO_DATABASE_URL=file:./prisma/replica.db
 *                                  TURSO_SYNC_URL=libsql://<db>.turso.io
 *                                  TURSO_SYNC_INTERVAL=60
 *
 * Tests swap in TEST_DATABASE_URL so the development database is never touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import type { Config as LibsqlConfig } from '@libsql/client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { PrismaClient } from '../generated/prisma/client';

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

/** The connection string this process actually uses (tests prefer TEST_DATABASE_URL). */
export const runtimeDatabaseUrl: string =
  config.isTest && config.db.testUrl ? config.db.testUrl : config.db.url;

export const isLocalDatabase = runtimeDatabaseUrl.startsWith('file:');

/**
 * Statement-level tuning for a local SQLite file. Turso already runs its
 * databases in WAL mode with a server-side busy timeout, so this only runs when
 * the URL points at a file on this machine. `journal_mode` is persisted in the
 * database header; the rest are per connection.
 */
const LOCAL_PRAGMAS: Array<{ sql: string; returnsRows: boolean }> = [
  { sql: 'PRAGMA journal_mode = WAL', returnsRows: true }, // readers never block the writer
  { sql: 'PRAGMA synchronous = NORMAL', returnsRows: false }, // WAL + NORMAL = standard durability
  { sql: 'PRAGMA busy_timeout = 5000', returnsRows: false }, // wait instead of SQLITE_BUSY
  { sql: 'PRAGMA foreign_keys = ON', returnsRows: false }, // enforce ON DELETE CASCADE
  { sql: 'PRAGMA temp_store = MEMORY', returnsRows: false },
];

/** The parent directory of a `file:` URL must exist before libSQL opens it. */
function ensureLocalDirectory(url: string): void {
  if (!url.startsWith('file:')) return;
  const file = url.slice('file:'.length).split('?')[0] ?? '';
  if (!file || file.startsWith(':memory:') || file.startsWith('//')) return;
  const dir = path.dirname(path.resolve(file));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function libsqlConfig(): LibsqlConfig {
  const url = runtimeDatabaseUrl;
  ensureLocalDirectory(url);

  const clientConfig: LibsqlConfig = {
    url,
    // Money safety: never let the driver coerce an INTEGER through a JS number.
    intMode: 'bigint',
    ...(config.db.authToken ? { authToken: config.db.authToken } : {}),
  };

  if (config.db.embeddedReplica && config.db.syncUrl) {
    // Embedded replica: `url` stays the local file, writes are forwarded to the
    // primary behind `syncUrl`, reads are served locally between syncs.
    clientConfig.syncUrl = config.db.syncUrl;
    clientConfig.syncInterval = config.db.syncInterval;
    if (config.db.encryptionKey) clientConfig.encryptionKey = config.db.encryptionKey;
  }

  return clientConfig;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    adapter: new PrismaLibSql(libsqlConfig()),
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

  client.$on('warn' as never, (e: { message?: string }) => logger.warn({ prisma: e }, 'prisma warning'));
  client.$on('error' as never, (e: { message?: string }) => logger.error({ prisma: e }, 'prisma error'));
  if (config.isDev) {
    client.$on('query' as never, (e: { query?: string; duration?: number }) => {
      if ((e.duration ?? 0) > 200) logger.debug({ query: e.query, ms: e.duration }, 'slow query');
    });
  }
  return client;
}

export const prisma: PrismaClient = globalForPrisma.__prisma ?? createPrismaClient();

if (!config.isProd) {
  globalForPrisma.__prisma = prisma;
}

/** Applies the local-file tuning above (no-op for remote Turso databases). */
export async function applyConnectionPragmas(): Promise<void> {
  if (!isLocalDatabase) return;
  for (const { sql, returnsRows } of LOCAL_PRAGMAS) {
    try {
      if (returnsRows) await prisma.$queryRawUnsafe(sql);
      else await prisma.$executeRawUnsafe(sql);
    } catch (error) {
      logger.debug({ err: error, pragma: sql }, 'pragma failed (non-fatal)');
    }
  }
}

/**
 * Boot-time database check: tunes the connection, then proves it is reachable so
 * a misconfigured token or URL fails fast instead of surfacing as 500s later.
 */
export async function connectDatabase(): Promise<void> {
  await applyConnectionPragmas();
  await prisma.$queryRaw`SELECT 1`;
  logger.info(
    {
      database: runtimeDatabaseUrl.replace(/\/\/[^@]*@/, '//'),
      embeddedReplica: config.db.embeddedReplica,
    },
    'database connection ok (Turso / libSQL)',
  );
}

/** Graceful shutdown: closes Prisma (which closes the libSQL client). */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect().catch(() => undefined);
}

/** Transaction client type used by services. */
export type Tx = import('../generated/prisma/client').Prisma.TransactionClient;

export * from '../generated/prisma/client';
