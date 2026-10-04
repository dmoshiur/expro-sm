import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '../src/utils/auditActions';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith, request, app } from './helpers/http';

describe('RBAC on /api/admins (SUPER_ADMIN only)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('rejects anonymous requests', async () => {
    await request(app).get('/api/admins').expect(401);
    await request(app).post('/api/admins').send({}).expect(401);
  });

  it('blocks ACCOUNTANT and VIEWER from every admin route', async () => {
    for (const role of ['ACCOUNTANT', 'VIEWER'] as const) {
      const email = `${role.toLowerCase()}@test.local`;
      const target = await createTestAdmin({ email: `target-${role}@test.local`, role: 'VIEWER' });
      await createTestAdmin({ email, role });
      const { client } = await loginWith({ email });

      await client.get('/api/admins').expect(403);
      await client
        .post('/api/admins')
        .send({ name: 'Nope', email: 'nope@test.local', password: 'ValidPassw0rd1', role: 'VIEWER' })
        .expect(403);
      await client.patch(`/api/admins/${target.id}`).send({ role: 'SUPER_ADMIN' }).expect(403);
      await client.post(`/api/admins/${target.id}/reset-2fa`).expect(403);
      await client.post(`/api/admins/${target.id}/unlock`).expect(403);
    }
  });

  it('lets a SUPER_ADMIN create, list and update admins', async () => {
    await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
    const { client } = await loginWith({ email: 'super@test.local' });

    const created = await client
      .post('/api/admins')
      .send({ name: 'New Accountant', email: 'new@test.local', password: 'ValidPassw0rd1', role: 'ACCOUNTANT' })
      .expect(201);
    expect(created.body.admin.email).toBe('new@test.local');

    // password hash is never returned
    expect(JSON.stringify(created.body)).not.toContain('$argon2');

    const list = await client.get('/api/admins?search=new').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.total).toBe(1);

    await client.patch(`/api/admins/${created.body.admin.id}`).send({ role: 'VIEWER' }).expect(200);
    const updated = await prisma.admin.findUnique({ where: { email: 'new@test.local' } });
    expect(updated?.role).toBe('VIEWER');

    expect(await auditRows(AuditAction.ADMIN_CREATED)).toHaveLength(1);
    expect(await auditRows(AuditAction.ADMIN_ROLE_CHANGED)).toHaveLength(1);
  });

  it('refuses duplicates and self-demotion', async () => {
    const superAdmin = await createTestAdmin({ email: 'super2@test.local', role: 'SUPER_ADMIN' });
    await createTestAdmin({ email: 'taken@test.local', role: 'VIEWER' });
    const { client } = await loginWith({ email: 'super2@test.local' });

    const duplicate = await client
      .post('/api/admins')
      .send({ name: 'Dupe', email: 'taken@test.local', password: 'ValidPassw0rd1', role: 'VIEWER' })
      .expect(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');

    await client.patch(`/api/admins/${superAdmin.id}`).send({ role: 'VIEWER' }).expect(400);
    await client.patch(`/api/admins/${superAdmin.id}`).send({ isActive: false }).expect(400);
  });

  it('keeps at least one active super admin in the system', async () => {
    const first = await createTestAdmin({ email: 'first@test.local', role: 'SUPER_ADMIN' });
    await createTestAdmin({ email: 'second@test.local', role: 'SUPER_ADMIN' });
    const { client } = await loginWith({ email: 'second@test.local' });

    // disable the other super admin - allowed, one remains (the caller)
    await client.patch(`/api/admins/${first.id}`).send({ isActive: false }).expect(200);

    // now the caller is the only active super admin and cannot demote itself
    await client.patch(`/api/admins/${(await prisma.admin.findUnique({ where: { email: 'second@test.local' } }))!.id}`).send({ role: 'ACCOUNTANT' }).expect(400);
  });

  it('disabling an admin kills their sessions immediately', async () => {
    const victim = await createTestAdmin({ email: 'victim@test.local', role: 'ACCOUNTANT' });
    await createTestAdmin({ email: 'boss@test.local', role: 'SUPER_ADMIN' });
    const victimSession = await loginWith({ email: 'victim@test.local' });
    await victimSession.client.get('/api/auth/me').expect(200);

    const boss = await loginWith({ email: 'boss@test.local' });
    await boss.client.patch(`/api/admins/${victim.id}`).send({ isActive: false }).expect(200);

    expect(await prisma.refreshToken.count({ where: { adminId: victim.id, revokedAt: null } })).toBe(0);
    await victimSession.client.get('/api/auth/me').expect(403);
    expect(await auditRows(AuditAction.ADMIN_DISABLED)).toHaveLength(1);
  });

  it('resets 2FA and unlocks a locked account', async () => {
    const target = await createTestAdmin({
      email: 'locked@test.local',
      role: 'ACCOUNTANT',
      failedLoginCount: 5,
      lockedUntil: new Date(Date.now() + 60_000),
    });
    await createTestAdmin({ email: 'boss2@test.local', role: 'SUPER_ADMIN' });
    const { client } = await loginWith({ email: 'boss2@test.local' });

    const reset = await client.post(`/api/admins/${target.id}/reset-2fa`).expect(200);
    expect(reset.body.pendingSecret).toBeTruthy();
    const after = await prisma.admin.findUnique({ where: { id: target.id } });
    expect(after?.twoFAEnabled).toBe(false);
    expect(after?.twoFASecret).toBeTruthy();
    expect(await auditRows(AuditAction.TWO_FA_RESET)).toHaveLength(1);

    const unlocked = await client.post(`/api/admins/${target.id}/unlock`).expect(200);
    expect(unlocked.body.admin.lockedUntil).toBeNull();
    expect(unlocked.body.admin.failedLoginCount).toBe(0);
  });

  it('does not accept a modified role from a stale UI (server is authoritative)', async () => {
    await createTestAdmin({ email: 'viewer2@test.local', role: 'VIEWER' });
    const { client } = await loginWith({ email: 'viewer2@test.local' });
    const response = await client.get('/api/admins').expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.message).toMatch(/ACCOUNTANT|SUPER_ADMIN|permission|allowed/i);
  });
});
