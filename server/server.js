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
 *   4. sync the seed Super Admin from SEED_SUPER_ADMIN_* when both variables are
 *      set (create when missing; re-hash the password when it no longer verifies
 *      against the env value) - see auth.service syncSuperAdminFromEnv
 *   5. start the in-process job scheduler (Asia/Dhaka aware, idempotent)
 *   6. listen on BIND_HOST:PORT (Render sets PORT) and serve API + built SPA
 *   7. graceful shutdown on SIGTERM/SIGINT (drain, close the database, stop jobs)
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, validateConfig } from './src/config/index.js';
import { createApp, CLIENT_DIST } from './src/app.js';
import { logger } from './src/utils/logger.js';
import { connectDatabase, closeDatabase, probeForeignKeys } from './src/db/client.js';
import { runMigrations } from './src/db/migrate.js';
import { syncSuperAdminFromEnv } from './src/services/auth.service.js';
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
    // Read-only verification shares the runner's metadata and checksum checks.
    const { pending } = await runMigrations({ dryRun: true, log: logger });
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

  // Seed Super Admin sync from SEED_SUPER_ADMIN_EMAIL / SEED_SUPER_ADMIN_PASSWORD.
  // Runs before listen() so the very first login after a (re)deploy already uses
  // the env credentials. A failure (e.g. a password that violates the policy)
  // must never take the whole site down: it is logged loudly and the operator
  // can fix the variable / run `npm run reset-admin` instead.
  try {
    await syncSuperAdminFromEnv();
  } catch (err) {
    logger.error(
      'seed super admin sync failed - check SEED_SUPER_ADMIN_* (password policy: at least 12 chars with upper, lower, digit and symbol, not containing the email name) or run "npm run reset-admin" from the Render Shell',
      { err },
    );
  }

  if (config.isProd) {
    if (config.payments.provider === 'mock') {
      logger.warn('payment provider is mock in production – test-only, no real bKash transactions will occur', {
        provider: 'mock',
      });
    }
    if (config.sms.provider === 'console' || config.sms.dryRun) {
      logger.info('sms provider is console/dry-run in production – messages are logged, not sent', {
        provider: config.sms.provider,
        dryRun: config.sms.dryRun,
      });
    }
  }

  // Production must have a built frontend; fail fast rather than serving a
  // perpetual 503 placeholder. The build pipeline (npm run build) already runs
  // verify-build.mjs, but this guard catches a mis-configured Render build
  // that skipped the build step or a corrupted deploy.
  if (config.isProd) {
    const indexHtml = join(CLIENT_DIST, 'index.html');
    if (!existsSync(indexHtml)) {
      const msg = `Frontend build not found at ${indexHtml}. Run \`npm run build\` (and ensure Render Build Command is \`npm ci && npm run build\`) before starting in production.`;
      logger.error('missing frontend build - refusing to start', { dir: CLIENT_DIST });
      process.stderr.write(`\n${msg}\n\n`);
      await closeDatabase();
      process.exit(1);
    }
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
