#!/usr/bin/env node
/**
 * Single-process entrypoint (production: `node server/server.js`, no --env-file).
 *
 * Boot sequence
 *   1. validate configuration (fail fast on missing/unsafe database or secrets)
 *   2. connect to Turso and verify the connection
 *   3. confirm the schema is up to date. Migrations are NOT applied silently in
 *      production: run `npm run migrate` explicitly. DB_MIGRATE_ON_START=true opts
 *      in to applying them at boot (additive, checksum-protected, idempotent).
 *   4. start the in-process job scheduler (Asia/Dhaka aware, idempotent)
 *   5. listen on BIND_HOST:PORT (Render sets PORT) and serve API + built SPA
 *   6. graceful shutdown on SIGTERM/SIGINT (drain, close the database, stop jobs)
 */
import { createServer } from 'node:http';
import { config, validateConfig } from './src/config/index.js';
import { createApp } from './src/app.js';
import { logger } from './src/utils/logger.js';
import { connectDatabase, closeDatabase, probeForeignKeys } from './src/db/client.js';
import { appliedMigrations, listMigrationFiles, runMigrations } from './src/db/migrate.js';
import { startScheduler, stopScheduler } from './src/jobs/scheduler.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main() {
  const problems = validateConfig(config);
  if (problems.length > 0) {
    logger.error('invalid configuration - refusing to start', { problems });
    process.stderr.write(`\nConfiguration problems:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\n`);
    process.exit(1);
  }

  // Throws a sanitized error (no URL or token) when Turso is unreachable or rejects the token.
  const target = await connectDatabase();
  logger.info('database connected', { kind: target.kind, host: target.host });

  if (config.db.migrateOnStart) {
    const result = await runMigrations({ log: logger });
    if (result.applied.length) logger.info('startup migrations applied', { files: result.applied });
  } else {
    const files = await listMigrationFiles();
    const done = new Set((await appliedMigrations()).map((r) => r.filename));
    const pending = files.filter((f) => !done.has(f));
    if (pending.length > 0) {
      const msg = `Database schema is missing ${pending.length} migration(s): ${pending.join(', ')}. Run "npm run migrate" first (or set DB_MIGRATE_ON_START=true).`;
      logger.error('pending migrations - refusing to start', { pending });
      process.stderr.write(`\n${msg}\n\n`);
      await closeDatabase();
      process.exit(1);
    }
  }

  const fk = await probeForeignKeys();
  logger.info('database foreign keys', { enforcement: fk });

  const app = createApp({ serveStatic: true });
  const server = createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bindHost, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  logger.info('investor portal listening', {
    host: config.bindHost,
    port: config.port,
    env: config.nodeEnv,
    publicBaseUrl: config.publicBaseUrl,
    paymentProvider: config.payments.provider,
    smsProvider: config.sms.provider,
    timeZone: 'Asia/Dhaka',
  });

  if (config.jobs.enabled) startScheduler();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown requested', { signal });
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out - forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      stopScheduler();
      await new Promise((resolve) => server.close(resolve));
      closeDatabase();
      logger.info('shutdown complete');
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      logger.error('shutdown error', { err });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception - shutting down', { err });
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.error('fatal startup error', { err });
  process.stderr.write(`\nStartup failed: ${err?.message ?? err}\n\n`);
  try {
    closeDatabase();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
