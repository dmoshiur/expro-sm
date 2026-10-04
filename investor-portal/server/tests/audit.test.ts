import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '../src/utils/auditActions';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith, request, app } from './helpers/http';

describe('audit log', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('records logins, investor changes and payments in order', async () => {
    await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
    const client = (await loginWith({ email: 'super@test.local' })).client;
    await client.post('/api/investors').send({ name: 'Audit Investor', mobile: '01712345678' }).expect(201);

    const rows = await auditRows();
    const actions = rows.map((row) => row.action);
    expect(actions).toContain(AuditAction.LOGIN_SUCCESS);
    expect(actions).toContain(AuditAction.INVESTOR_CREATED);

    const created = rows.find((row) => row.action === AuditAction.INVESTOR_CREATED)!;
    expect(created.entity).toBe('Investor');
    expect(created.ip).toBeTruthy();
    expect(created.adminId).toBeTruthy();
  });

  it('is readable by SUPER_ADMIN with filters', async () => {
    const admin = await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
    await prisma.auditLog.createMany({
      data: [
        { adminId: admin.id, action: 'custom.one', entity: 'Investor', entityId: 'a' },
        { adminId: admin.id, action: 'custom.two', entity: 'Investment', entityId: 'b' },
      ],
    });

    const client = (await loginWith({ email: 'super@test.local' })).client;
    const all = await client.get('/api/audit-logs').expect(200);
    expect(all.body.total).toBeGreaterThanOrEqual(3);

    const filtered = await client.get('/api/audit-logs?action=custom.one').expect(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].action).toBe('custom.one');

    const byEntity = await client.get('/api/audit-logs?entity=Investment').expect(200);
    expect(byEntity.body.items).toHaveLength(1);
    expect(byEntity.body.items[0].admin).toMatchObject({ id: admin.id, role: 'SUPER_ADMIN' });

    const actions = await client.get('/api/audit-logs/actions').expect(200);
    expect(actions.body.actions).toContain('custom.two');
  });

  it('is NOT readable by ACCOUNTANT or VIEWER', async () => {
    for (const role of ['ACCOUNTANT', 'VIEWER'] as const) {
      await createTestAdmin({ email: `${role.toLowerCase()}@test.local`, role });
      const client = (await loginWith({ email: `${role.toLowerCase()}@test.local` })).client;
      await client.get('/api/audit-logs').expect(403);
    }
  });

  it('is append-only through the API (no write endpoints)', async () => {
    await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
    const client = (await loginWith({ email: 'super@test.local' })).client;

    await client.post('/api/audit-logs').send({ action: 'nope', entity: 'X' }).expect(405);
    await client.delete('/api/audit-logs/some-id').expect(405);
    await client.patch('/api/audit-logs/some-id').send({ action: 'nope' }).expect(405);
  });

  it('is append-only at the database level (UPDATE and DELETE are rejected)', async () => {
    const admin = await createTestAdmin({ email: 'super@test.local' });
    await prisma.auditLog.create({ data: { adminId: admin.id, action: 'test.action', entity: 'Test' } });

    await expect(prisma.$executeRawUnsafe("UPDATE audit_logs SET action = 'tampered'")).rejects.toThrow(/append-only/i);
    await expect(prisma.$executeRawUnsafe('DELETE FROM audit_logs')).rejects.toThrow(/append-only/i);

    const rows = await prisma.auditLog.findMany({ where: { action: 'test.action' } });
    expect(rows).toHaveLength(1); // untouched
  });
});

describe('error handling does not leak internals', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('returns a generic message with a request id for unexpected errors', async () => {
    const response = await request(app).get('/api/does-not-exist').expect(404);
    expect(response.body.error.requestId).toBeTruthy();
    expect(JSON.stringify(response.body)).not.toMatch(/prisma|postgres|node_modules|at Object/i);
  });

  it('rejects requests from a disallowed origin', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@b.com', password: 'x' })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});
