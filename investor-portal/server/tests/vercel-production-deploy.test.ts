import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const deployScript = path.join(process.cwd(), 'scripts', 'vercel-production-deploy.mjs');

function runDeployScript(overrides: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [deployScript], {
    cwd: process.cwd(),
    env: { ...process.env, ...overrides },
    encoding: 'utf8',
  });
}

describe('Vercel production database bootstrap', () => {
  it('never mutates a database from a Preview build', () => {
    const result = runDeployScript({
      VERCEL_ENV: 'preview',
      TURSO_DATABASE_URL: '',
      DATABASE_URL: '',
      TURSO_AUTH_TOKEN: '',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/skipping production database setup/i);
  });

  it('fails a Production build closed when the hosted database URL is missing', () => {
    const result = runDeployScript({
      VERCEL_ENV: 'production',
      TURSO_DATABASE_URL: '',
      DATABASE_URL: '',
      TURSO_AUTH_TOKEN: 'test-token',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires TURSO_DATABASE_URL/i);
  });

  it('fails a Production build closed when the Turso auth token is missing', () => {
    const result = runDeployScript({
      VERCEL_ENV: 'production',
      TURSO_DATABASE_URL: 'libsql://database-org.turso.io',
      DATABASE_URL: '',
      TURSO_AUTH_TOKEN: '',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires TURSO_AUTH_TOKEN/i);
  });
});
