import { beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { AuditAction } from '../src/utils/auditActions';
import { decrypt } from '../src/utils/encryption';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith } from './helpers/http';

describe('two-factor authentication', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('enrols 2FA: setup returns a QR code, verify switches 2FA on', async () => {
    await createTestAdmin({ email: 'enrol@test.local' });
    const { client } = await loginWith({ email: 'enrol@test.local' });

    const setup = await client.post('/api/auth/2fa/setup').expect(200);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.body.secret).toBeUndefined(); // only the QR/otpauth URL is exposed

    const admin = await prisma.admin.findUnique({ where: { email: 'enrol@test.local' } });
    expect(admin?.twoFASecret).toBeTruthy();
    expect(admin?.twoFASecret).not.toMatch(/^[A-Z2-7]+$/); // stored encrypted, not plain base32
    const secret = decrypt(admin!.twoFASecret!);

    const wrong = await client.post('/api/auth/2fa/verify').send({ code: '111111' }).expect(401);
    expect(wrong.body.error.code).toBe('UNAUTHORIZED');

    await client.post('/api/auth/2fa/verify').send({ code: authenticator.generate(secret) }).expect(200);
    expect((await prisma.admin.findUnique({ where: { email: 'enrol@test.local' } }))?.twoFAEnabled).toBe(true);
    expect(await auditRows(AuditAction.TWO_FA_ENABLED)).toHaveLength(1);
  });

  it('requires the 2FA code on every subsequent login', async () => {
    const secret = authenticator.generateSecret();
    await createTestAdmin({ email: 'reverify@test.local' });
    const { client } = await loginWith({ email: 'reverify@test.local' });
    await client.post('/api/auth/2fa/setup').expect(200);
    await client.post('/api/auth/2fa/verify').send({ code: authenticator.generate(decrypt((await prisma.admin.findUnique({ where: { email: 'reverify@test.local' } }))!.twoFASecret!)) }).expect(200);

    const first = await loginWith({ email: 'reverify@test.local' });
    expect(first.response.body).toEqual({ twoFactorRequired: true });

    const stored = (await prisma.admin.findUnique({ where: { email: 'reverify@test.local' } }))!.twoFASecret!;
    const ok = await loginWith({ email: 'reverify@test.local', totp: authenticator.generate(decrypt(stored)) });
    expect(ok.response.status).toBe(200);
    void secret;
  });

  it('disables 2FA when the password is provided', async () => {
    const secret = authenticator.generateSecret();
    await createTestAdmin({ email: 'disable@test.local', twoFAEnabled: true, twoFASecretEncrypted: (await import('../src/utils/encryption')).encrypt(secret) });
    const { client } = await loginWith({ email: 'disable@test.local', totp: authenticator.generate(secret) });

    await client.post('/api/auth/2fa/disable').send({ password: 'TotallyWrong1' }).expect(400);
    await client.post('/api/auth/2fa/disable').send({ password: 'TestPassw0rd!' }).expect(200);

    const admin = await prisma.admin.findUnique({ where: { email: 'disable@test.local' } });
    expect(admin?.twoFAEnabled).toBe(false);
    expect(admin?.twoFASecret).toBeNull();
    expect(await auditRows(AuditAction.TWO_FA_DISABLED)).toHaveLength(1);
  });
});
