#!/usr/bin/env node
/**
 * Production configuration preflight.
 *
 * Runs the exact same checks the server runs at boot (`configProblems`, see
 * src/config/index.ts) and prints every missing/invalid setting with the
 * subsystem it blocks, then exits non-zero when something is missing.
 *
 * Use it to verify a Vercel deployment's environment without deploying:
 *
 *   vercel env pull .env.production          # or copy the values by hand
 *   npm --workspace server run env:check -- --env-file .env.production
 *
 * By default the check simulates a Vercel production deployment (that is where
 * the strict guardrails apply). Pass --self-hosted to check a VPS/container
 * deployment instead, or --json to get machine-readable output for CI.
 */
import fs from 'node:fs';
import path from 'node:path';

interface Options {
  envFile?: string;
  selfHosted: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { selfHosted: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--env-file' || arg === '-e') {
      const value = argv[i + 1];
      if (!value) {
        console.error('error: --env-file needs a path, e.g. --env-file .env.production');
        process.exit(2);
      }
      options.envFile = value;
      i += 1;
    } else if (arg === '--self-hosted') {
      options.selfHosted = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: npm --workspace server run env:check -- [--env-file <path>] [--self-hosted] [--json]',
          '',
          '  --env-file <path>  load values from a file (e.g. `vercel env pull .env.production`)',
          '  --self-hosted      check a VPS/container deployment instead of Vercel production',
          '  --json             print the problems as JSON (for CI)',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      console.error(`error: unknown argument "${arg}" (try --help)`);
      process.exit(2);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.envFile) {
  const envFile = path.resolve(options.envFile);
  if (!fs.existsSync(envFile)) {
    console.error(`error: env file not found: ${envFile}`);
    process.exit(2);
  }
  if (typeof process.loadEnvFile !== 'function') {
    console.error('error: loading an env file requires Node.js 20.12 or newer');
    process.exit(2);
  }
  // Values already present in the shell win, exactly like a real deployment.
  // The format is dotenv style (one KEY=value per line, `export ` tolerated,
  // quotes optional) - the same format `vercel env pull` writes.
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) {
      console.error(`warning: ignoring unparsable line in ${options.envFile}: ${line}`);
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      console.error(`warning: ignoring invalid variable name in ${options.envFile}: ${key}`);
      continue;
    }
    if (/\s[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      console.error(
        `warning: ${options.envFile}: "${key}" captured more than one assignment - use one KEY=value per line`,
      );
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  // stderr: keeps `--json` output on stdout machine-readable
  console.error(`loaded ${options.envFile}`);
}

// The script prints the problems itself (grouped, with an exit code), so keep the
// configuration module from printing the same list first.
process.env.CONFIG_PROBLEMS_SILENT = '1';

// Simulate the target deployment *before* the configuration module is imported,
// so `loadLocalEnvironment()` (which is a no-op when a Vercel deployment is
// detected) cannot paper over a missing value with server/.env.
process.env.NODE_ENV = 'production';
if (options.selfHosted) {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
} else {
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = process.env.VERCEL_ENV === 'preview' ? 'preview' : 'production';
}

async function main(): Promise<void> {
  const { config, configProblems } = await import('../src/config/index');
  const target = options.selfHosted ? 'self-hosted production' : `Vercel ${process.env.VERCEL_ENV}`;

  if (options.json) {
    console.log(JSON.stringify({ target, problems: configProblems }, null, 2));
    process.exit(configProblems.length > 0 ? 1 : 0);
  }

  console.log(
    `\nchecking ${target} configuration (NODE_ENV=${config.env}, database=${config.db.url.replace(/\/\/[^@]*@/, '//')})\n`,
  );

  if (configProblems.length === 0) {
    console.log('✓ every required production setting is present and valid');
    process.exit(0);
  }

  const blocking = configProblems.filter((problem) => problem.scope === 'core');
  for (const problem of configProblems) {
    console.log(`✗ [${problem.scope}] ${problem.message}`);
  }
  console.log(
    blocking.length > 0
      ? `\n${configProblems.length} problem(s), ${blocking.length} of them core: the API will answer HTTP 503 until they are fixed.`
      : `\n${configProblems.length} problem(s): the API runs, but the scopes above are disabled.`,
  );
  process.exit(1);
}

void main();
