/**
 * Load the server's local .env file without making it a runtime dependency.
 *
 * Vercel injects environment variables directly, so production functions must
 * never depend on an optional dotenv package or a checked-in env file. For
 * local/VPS use, Node's built-in `process.loadEnvFile` provides the same
 * development convenience.
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadLocalEnvironment(): void {
  const vercelEnvironment = process.env.VERCEL_ENV;
  const isVercelDeployment =
    vercelEnvironment === 'production' ||
    vercelEnvironment === 'preview' ||
    (process.env.VERCEL === '1' && vercelEnvironment !== 'development');

  if (isVercelDeployment) return;

  // Find the server's .env whether a command is run from the workspace,
  // monorepo root, or repository root. Prefer server/.env over a monorepo .env.
  const roots: string[] = [];
  let root = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    roots.push(root);
    const parent = path.dirname(root);
    if (parent === root) break;
    root = parent;
  }

  const candidates = roots.flatMap((directory) => [
    path.join(directory, 'server', '.env'),
    path.join(directory, 'investor-portal', 'server', '.env'),
    path.join(directory, '.env'),
  ]);
  const envFile = candidates.find((candidate) => fs.existsSync(candidate));
  if (!envFile) return;

  if (typeof process.loadEnvFile !== 'function') {
    throw new Error('Loading local .env files requires Node.js 20.12 or newer.');
  }

  // Existing shell/CI variables win over local defaults.
  process.loadEnvFile(envFile);
}
