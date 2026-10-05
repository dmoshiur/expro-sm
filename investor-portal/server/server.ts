/**
 * HTTP server entrypoint.
 *
 * Responsibilities:
 *  - start the Express app on PORT (0.0.0.0 so containers/proxies can reach it)
 *  - fail fast when the database is unreachable
 *  - start the scheduled jobs (Asia/Dhaka) unless RUN_JOBS=false
 *  - shut down gracefully on SIGTERM/SIGINT (PM2 reload friendly)
 */
import http from 'node:http';
import { config } from './src/config';
import { connectDatabase, disconnectPrisma } from './src/config/prisma';
import { createApp } from './src/app';
import { logger } from './src/utils/logger';
import { startJobs, stopJobs } from './src/jobs';

async function bootstrap(): Promise<void> {
  // Fail fast: a wrong Turso URL or expired auth token must not surface as 500s
  // later. For a local `file:` database this also switches on WAL and the other
  // connection pragmas (see src/config/prisma.ts).
  try {
    await connectDatabase();
  } catch (error) {
    logger.error(
      { err: error },
      'cannot reach the database - check TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (or the local file path)',
    );
    process.exit(1);
  }

  const app = createApp();
  const server = http.createServer(app);

  server.listen(config.port, '0.0.0.0', () => {
    logger.info(
      { port: config.port, env: config.env, cors: config.corsOrigins, bkash: config.bkash.mode },
      `investor-portal API listening on http://0.0.0.0:${config.port}`,
    );
  });

  if (config.runJobs) {
    startJobs();
  } else {
    logger.warn({ env: config.env }, 'scheduled jobs disabled on this instance (RUN_JOBS=false)');
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    stopJobs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectPrisma();
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception - exiting');
    process.exit(1);
  });
}

void bootstrap();
