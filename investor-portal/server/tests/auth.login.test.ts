import { beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { config } from '../src/config';
import { AuditAction } from '../src/utils/auditActions';
import { encrypt } from '../src/utils/encryption';
import { auditRows, createTestAdmin, prisma, TEST_PASSWORD, truncateAll } from './helpers/db';
import { loginWith, request, app } from './helpers/http';

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('signs an admin in and sets httpOnly cookies', async () => {
    const admin = await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
    const { response } = await loginWith({ email: 'super@test.local' });

    expect(response.status).toBe(200);
    expect(response.body.admin).toMatchObject({ id: admin.id, email: 'super@test.local', role: 'SUPER_ADMIN' });

    const cookies = response.headers['set-cookie'] as unknown as string[];
    const access = cookies.find((c) => c.startsWith(`${config.auth.accessCookieName}=`))!;
    const refresh = cookies.find((c) => c.startsWith(`${config.auth.refreshCookieName}=`))!;
    expect(access).toContain('HttpOnly');
    expect(access).toContain('SameSite=Lax');
    expect(refresh).toContain('HttpOnly');
    expect(refresh).toContain(`Path=${'/api/auth'}`);

    // the JSON body must never contain a token
    expect(JSON.stringify(response.body)).not.toContain('eyJ');

    const audits = await auditRows(AuditAction.LOGIN_SUCCESS);
    expect(audits).toHaveLength(1);
  });

  it('rejects a wrong password with a generic message and records the failure', async () => {
    await createTestAdmin({ email: 'wrong@test.local' });
    const { response } = await loginWith({ email: 'wrong@test.local', password: 'NotThePassword1' });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Invalid email or password');

    const admin = await prisma.admin.findUnique({ where: { email: 'wrong@test.local' } });
    expect(admin?.failedLoginCount).toBe(1);
    expect(await auditRows(AuditAction.LOGIN_FAILED)).toHaveLength(1);
  });

  it('gives the same generic error for an unknown email (no user enumeration)', async () => {
    await createTestAdmin({ email: 'known@test.local' });
    const unknown = await loginWith({ email: 'nobody@test.local' });
    const wrongPassword = await loginWith({ email: 'known@test.local', password: 'WrongPassword9' });

    expect(unknown.response.status).toBe(401);
    expect(unknown.response.body.error.message).toBe(wrongPassword.response.body.error.message);
  });

  it('locks the account after the configured number of failures', async () => {
    await createTestAdmin({ email: 'lock@test.local' });
    for (let attempt = 1; attempt <= config.auth.maxLoginAttempts; attempt += 1) {
      const { response } = await loginWith({ email: 'lock@test.local', password: 'BadPassword1' });
      expect(response.status).toBe(attempt < config.auth.maxLoginAttempts ? 401 : 403);
    }

    const admin = await prisma.admin.findUnique({ where: { email: 'lock@test.local' } });
    expect(admin?.lockedUntil).toBeTruthy();
    expect(admin?.failedLoginCount).toBe(config.auth.maxLoginAttempts);
    expect(await auditRows(AuditAction.LOGIN_LOCKED)).toHaveLength(1);

    // even the correct password is refused while locked
    const locked = await loginWith({ email: 'lock@test.local', password: TEST_PASSWORD });
    expect(locked.response.status).toBe(403);
  });

  it('refuses disabled accounts', async () => {
    await createTestAdmin({ email: 'disabled@test.local', isActive: false });
    const { response } = await loginWith({ email: 'disabled@test.local' });
    expect(response.status).toBe(403);
  });

  it('requires a valid TOTP code when 2FA is enabled', async () => {
    const secret = authenticator.generateSecret();
    await createTestAdmin({ email: '2fa@test.local', twoFAEnabled: true, twoFASecretEncrypted: encrypt(secret) });

    const withoutCode = await loginWith({ email: '2fa@test.local' });
    expect(withoutCode.response.status).toBe(200);
    expect(withoutCode.response.body).toEqual({ twoFactorRequired: true });
    expect(withoutCode.response.headers['set-cookie']).toBeUndefined();

    const wrongCode = await loginWith({ email: '2fa@test.local', totp: '000000' });
    expect(wrongCode.response.status).toBe(401);

    const code = authenticator.generate(secret);
    const ok = await loginWith({ email: '2fa@test.local', totp: code });
    expect(ok.response.status).toBe(200);
    expect(ok.response.body.admin.email).toBe('2fa@test.local');
    expect(await auditRows(AuditAction.TWO_FA_FAILED)).toHaveLength(1);
  });

  it('validates the request body', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: '' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'email' })]),
    );
  });

  it('normalises the email to lower case', async () => {
    await createTestAdmin({ email: 'case@test.local' });
    const { response } = await loginWith({ email: 'CASE@TEST.LOCAL' });
    expect(response.status).toBe(200);
  });
});
