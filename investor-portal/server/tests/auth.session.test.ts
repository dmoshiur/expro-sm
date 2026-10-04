import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sha256 } from '../src/utils/encryption';
import { AuditAction } from '../src/utils/auditActions';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { agent, cookieValue, loginWith, request, app } from './helpers/http';

describe('sessions: refresh, rotation, logout and password change', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('rotates the refresh token and revokes the previous one', async () => {
    await createTestAdmin({ email: 'rotate@test.local' });
    const { client, response } = await loginWith({ email: 'rotate@test.local' });
    const firstRefresh = cookieValue(response, config.auth.refreshCookieName)!;
    expect(firstRefresh).toBeTruthy();

    const refreshed = await client.post('/api/auth/refresh').expect(200);
    const secondRefresh = cookieValue(refreshed, config.auth.refreshCookieName)!;
    expect(secondRefresh).not.toBe(firstRefresh);

    const rows = await prisma.refreshToken.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.revokedAt).toBeTruthy();
    expect(rows[0]!.replacedByHash).toBe(sha256(secondRefresh));
    expect(rows[1]!.tokenHash).toBe(sha256(secondRefresh));
    expect(await auditRows(AuditAction.TOKEN_REFRESH)).toHaveLength(1);
  });

  it('treats a replayed refresh token as theft and kills the whole family', async () => {
    const admin = await createTestAdmin({ email: 'reuse@test.local' });
    const { client, response } = await loginWith({ email: 'reuse@test.local' });
    const stolen = cookieValue(response, config.auth.refreshCookieName)!;

    await client.post('/api/auth/refresh').expect(200);

    // replay the old (rotated) token from a different client
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${config.auth.refreshCookieName}=${stolen}`)
      .expect(401);

    const active = await prisma.refreshToken.count({ where: { adminId: admin.id, revokedAt: null } });
    expect(active).toBe(0);
    expect(await auditRows(AuditAction.TOKEN_REUSE_DETECTED)).toHaveLength(1);
  });

  it('rejects an unknown or expired refresh token', async () => {
    await request(app).post('/api/auth/refresh').expect(401);

    const admin = await createTestAdmin({ email: 'expired@test.local' });
    await prisma.refreshToken.create({
      data: { adminId: admin.id, tokenHash: sha256('expired-token'), expiresAt: new Date(Date.now() - 1000) },
    });
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${config.auth.refreshCookieName}=expired-token`)
      .expect(401);
  });

  it('logs out by revoking the refresh token and clearing cookies', async () => {
    const admin = await createTestAdmin({ email: 'logout@test.local' });
    const { client } = await loginWith({ email: 'logout@test.local' });

    const response = await client.post('/api/auth/logout').expect(200);
    const cleared = (response.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cleared).toContain(`${config.auth.refreshCookieName}=;`);

    expect(await prisma.refreshToken.count({ where: { adminId: admin.id, revokedAt: null } })).toBe(0);
    expect(await auditRows(AuditAction.LOGOUT)).toHaveLength(1);
  });

  it('GET /api/auth/me requires a session', async () => {
    await request(app).get('/api/auth/me').expect(401);

    await createTestAdmin({ email: 'me@test.local', role: 'ACCOUNTANT' });
    const { client } = await loginWith({ email: 'me@test.local' });
    const response = await client.get('/api/auth/me').expect(200);
    expect(response.body.admin.role).toBe('ACCOUNTANT');
    expect(response.body.mustEnable2FA).toBe(true);
  });

  it('changes the password, revokes every session and blocks the old password', async () => {
    await createTestAdmin({ email: 'change@test.local' });
    const { client } = await loginWith({ email: 'change@test.local' });

    await client
      .post('/api/auth/change-password')
      .send({ currentPassword: 'TestPassw0rd!', newPassword: 'BrandNewPass9' })
      .expect(200);

    const admin = await prisma.admin.findUnique({ where: { email: 'change@test.local' } });
    expect(await prisma.refreshToken.count({ where: { adminId: admin!.id, revokedAt: null } })).toBe(0);
    expect(await auditRows(AuditAction.PASSWORD_CHANGED)).toHaveLength(1);

    await loginWith({ email: 'change@test.local', password: 'TestPassw0rd!' }).then(({ response }) =>
      expect(response.status).toBe(401),
    );
    await loginWith({ email: 'change@test.local', password: 'BrandNewPass9' }).then(({ response }) =>
      expect(response.status).toBe(200),
    );
  });

  it('rejects a weak or unchanged new password', async () => {
    await createTestAdmin({ email: 'weak@test.local' });
    const { client } = await loginWith({ email: 'weak@test.local' });

    const weak = await client
      .post('/api/auth/change-password')
      .send({ currentPassword: 'TestPassw0rd!', newPassword: 'short1' })
      .expect(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');

    const same = await client
      .post('/api/auth/change-password')
      .send({ currentPassword: 'TestPassw0rd!', newPassword: 'TestPassw0rd!' })
      .expect(400);
    expect(same.body.error.message).toMatch(/different/);
  });

  it('ignores a forged access token cookie', async () => {
    await createTestAdmin({ email: 'forge@test.local' });
    const forged = agent();
    await forged
      .get('/api/auth/me')
      .set('Cookie', `${config.auth.accessCookieName}=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad`)
      .expect(401);
  });
});
