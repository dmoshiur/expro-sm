/**
 * HTTP server entrypoint.
 *
 * Responsibilities:
 *  - start the Express app on PORT (0.0.0.0 so containers/proxies can reach it)
 *  - fail fast when the database is unreachable
 *  - start the scheduled jobs (Asia/Dhaka) unless JOBS_DISABLED=1
 *  - shut down gracefully on SIGTERM/SIGINT (PM2 reload friendly)
 */
import http from 'node:http';
import { config } from './src/config';
import { prisma, disconnectPrisma } from './src/config/prisma';
import { createApp } from './src/app';
import { logger } from './src/utils/logger';
import { startJobs, stopJobs } from './src/jobs';

async function bootstrap(): Promise<void> {
  // Fail fast: a misconfigured DATABASE_URL must not surface as 500s later.
  try {
    await prisma.$queryRaw`SELECT 1`;
    logger.info('database connection ok');
  } catch (error) {
    logger.error({ err: error }, 'cannot reach the database - check DATABASE_URL');
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

  if (process.env.JOBS_DISABLED !== '1') {
    startJobs();
  } else {
    logger.warn('scheduled jobs disabled (JOBS_DISABLED=1)');
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
