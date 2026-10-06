import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestAdmin, prisma, truncateAll } from './helpers/db';

const workspaceRoot = path.resolve(process.cwd(), '..');

function runSeed(email: string, password: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    SEED_DEMO: '',
    SEED_SUPER_ADMIN_EMAIL: email,
    SEED_SUPER_ADMIN_PASSWORD: password,
  };
  delete env.VERCEL;
  delete env.VERCEL_ENV;

  return spawnSync('npm', ['--workspace', 'server', 'run', 'seed'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env,
  });
}

describe('production bootstrap seed behavior', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('creates a first super admin and default settings from explicit bootstrap values', async () => {
    const result = runSeed('first-admin@test.local', 'BootstrapPassword123!');
    expect(result.status, result.stderr).toBe(0);

    const admin = await prisma.admin.findUnique({ where: { email: 'first-admin@test.local' } });
    expect(admin).toMatchObject({ email: 'first-admin@test.local', role: 'SUPER_ADMIN', name: 'Super Admin' });
    expect(admin?.passwordHash).not.toBe('BootstrapPassword123!');
    expect(await prisma.setting.count()).toBe(4);
  });

  it('does not add another privileged account if the bootstrap email changes on a later deploy', async () => {
    const existing = await createTestAdmin({ email: 'existing-admin@test.local', role: 'SUPER_ADMIN' });
    const result = runSeed('changed-admin@test.local', 'AnotherPassword123!');
    expect(result.status, result.stderr).toBe(0);

    expect(await prisma.admin.count()).toBe(1);
    expect(await prisma.admin.findUnique({ where: { id: existing.id } })).toBeTruthy();
    expect(await prisma.admin.findUnique({ where: { email: 'changed-admin@test.local' } })).toBeNull();
  });
});
