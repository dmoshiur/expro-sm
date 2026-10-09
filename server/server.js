#!/usr/bin/env node
/**
 * Single-process entrypoint.
 *   node --env-file=.env server/server.js
 *
 * Boot sequence
 *   1. validate configuration (fail fast on missing secrets)
 *   2. verify the database and (optionally) apply pending migrations
 *   3. start the in-process job scheduler (Asia/Dhaka aware, idempotent)
 *   4. listen on BIND_HOST:PORT and serve API + built SPA
 *   5. graceful shutdown on SIGTERM/SIGINT (drain, close pool, stop jobs)
 */
import { createServer } from 'node:http';
import { config, validateConfig } from './src/config/index.js';
import { createApp } from './src/app.js';
import { logger } from './src/utils/logger.js';
import { getPool, closePool, query } from './src/db/pool.js';
import { runMigrations } from './src/db/migrate.js';
import { startScheduler, stopScheduler } from './src/jobs/scheduler.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main() {
  const problems = validateConfig(config);
  if (problems.length > 0) {
    logger.error('invalid configuration - refusing to start', { problems });
    process.stderr.write(`\nConfiguration problems:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\n`);
    process.exit(1);
  }

  getPool();
  const dbCheck = await query('select 1 as ok');
  if (dbCheck.rows[0]?.ok !== 1) throw new Error('Database health check failed');

  if (String(process.env.RUN_MIGRATIONS_ON_START ?? 'true') !== 'false') {
    const result = await runMigrations({ log: logger });
    if (result.applied.length) logger.info('startup migrations applied', { files: result.applied });
  }

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
      await closePool();
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

main().catch(async (err) => {
  logger.error('fatal startup error', { err });
  await closePool().catch(() => {});
  process.exit(1);
});
