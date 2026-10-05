/**
 * Vercel Express entrypoint.
 *
 * Export the Express application itself so Vercel can invoke it as a
 * serverless function. Keep listen(), database boot checks, and in-process
 * cron scheduling in server.ts for long-running Node/VPS deployments only.
 */
import { createApp } from './src/app';

const app = createApp();

export default app;
