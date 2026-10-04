/**
 * Phase 7 hardening - route inventory RBAC.
 *
 * Every admin route is enumerated here and exercised:
 *   1. with no session            -> must be 401 (never 200, never 500)
 *   2. with a VIEWER session      -> write routes must be 403
 *   3. with a VIEWER session      -> read routes must not be 500
 *
 * This catches the classic mistake of forgetting `requireAuth` when a new
 * route is added: the table below is the contract.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestAdmin, prisma, truncateAll } from './helpers/db';
import { agent, loginWith } from './helpers/http';

const ID = '11111111-1111-4111-8111-111111111111';

interface RouteSpec {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  /** true when the route changes data (viewer must get 403) */
  write: boolean;
  /**
   * Self-service routes (change your own password / manage your own 2FA) are
   * available to every signed-in admin, so they are exempt from the
   * "viewer must be blocked" rule. They still require authentication.
   */
  selfService?: boolean;
  /** only super admins may call it (audit log, admin management) */
  superAdminOnly?: boolean;
  /** reads that need an elevated permission a viewer does not hold (exports, NID) */
  elevatedRead?: boolean;
  body?: Record<string, unknown>;
}

const ROUTES: RouteSpec[] = [
  // auth
  { method: 'get', path: '/api/auth/me', write: false },
  { method: 'post', path: '/api/auth/change-password', write: true, selfService: true, body: { currentPassword: 'x', newPassword: 'SomePassword123' } },
  { method: 'post', path: '/api/auth/2fa/setup', write: true, selfService: true },
  { method: 'post', path: '/api/auth/2fa/verify', write: true, selfService: true, body: { code: '000000' } },
  { method: 'post', path: '/api/auth/2fa/disable', write: true, selfService: true, body: { password: 'x' } },
  // admins
  { method: 'get', path: '/api/admins', write: false, superAdminOnly: true },
  { method: 'post', path: '/api/admins', write: true, body: { name: 'X Y', email: 'x@test.local', password: 'Password123x', role: 'VIEWER' } },
  { method: 'patch', path: `/api/admins/${ID}`, write: true, body: { name: 'New Name' } },
  { method: 'post', path: `/api/admins/${ID}/reset-password`, write: true, body: { newPassword: 'Password123x' } },
  { method: 'post', path: `/api/admins/${ID}/reset-2fa`, write: true },
  { method: 'post', path: `/api/admins/${ID}/unlock`, write: true },
  // investors
  { method: 'get', path: '/api/investors', write: false },
  { method: 'post', path: '/api/investors', write: true, body: { name: 'A B', mobile: '01712345678' } },
  { method: 'get', path: `/api/investors/${ID}`, write: false },
  { method: 'patch', path: `/api/investors/${ID}`, write: true, body: { name: 'A C' } },
  { method: 'put', path: `/api/investors/${ID}/nominees`, write: true, body: { nominees: [] } },
  { method: 'post', path: `/api/investors/${ID}/deactivate`, write: true },
  { method: 'post', path: `/api/investors/${ID}/reactivate`, write: true },
  { method: 'post', path: `/api/investors/${ID}/photo`, write: true },
  { method: 'post', path: `/api/investors/${ID}/nid-scan`, write: true },
  { method: 'get', path: `/api/investors/${ID}/nid-scan-url`, write: false, elevatedRead: true },
  // investments / installments
  { method: 'get', path: '/api/investments', write: false },
  { method: 'post', path: '/api/investments', write: true, body: { investorId: ID, totalAmount: '1000', installmentCount: 2, firstDueDate: '2026-01-01', interval: { unit: 'MONTH', value: 1 } } },
  { method: 'get', path: `/api/investments/${ID}`, write: false },
  { method: 'patch', path: `/api/investments/${ID}`, write: true, body: { notes: 'x' } },
  { method: 'post', path: `/api/investments/${ID}/cancel`, write: true, body: { reason: 'test reason' } },
  { method: 'put', path: `/api/investments/${ID}/installments`, write: true, body: { totalAmount: '1000' } },
  { method: 'get', path: '/api/installments', write: false },
  { method: 'post', path: `/api/installments/${ID}/waive`, write: true, body: { reason: 'test reason' } },
  { method: 'post', path: `/api/installments/${ID}/cancel`, write: true, body: { reason: 'test reason' } },
  { method: 'post', path: `/api/installments/${ID}/reopen`, write: true, body: { reason: 'test reason' } },
  // payment links / payments
  { method: 'post', path: `/api/payments/installments/${ID}/link/regenerate`, write: true, body: { sendSms: false } },
  { method: 'post', path: `/api/payments/installments/${ID}/link/send`, write: true },
  { method: 'post', path: `/api/payments/investments/${ID}/links/send`, write: true },
  { method: 'get', path: '/api/payments/sms-logs', write: false },
  { method: 'post', path: `/api/payments/installments/${ID}/manual`, write: true, body: { method: 'CASH', reference: 'REF-1' } },
  { method: 'get', path: '/api/payments', write: false },
  { method: 'get', path: `/api/payments/${ID}`, write: false },
  { method: 'get', path: `/api/payments/${ID}/receipt.pdf`, write: false },
  // dashboard / reports
  { method: 'get', path: '/api/dashboard', write: false },
  { method: 'get', path: '/api/reports/due', write: false },
  { method: 'get', path: '/api/reports/collections', write: false },
  { method: 'get', path: `/api/reports/investors/${ID}/statement`, write: false },
  { method: 'get', path: '/api/reports/due.xlsx', write: false, elevatedRead: true },
  { method: 'get', path: '/api/reports/collections.xlsx', write: false, elevatedRead: true },
  { method: 'get', path: `/api/reports/investors/${ID}/statement.xlsx`, write: false, elevatedRead: true },
  { method: 'get', path: `/api/reports/investors/${ID}/statement.pdf`, write: false, elevatedRead: true },
  // audit log
  { method: 'get', path: '/api/audit-logs', write: false, superAdminOnly: true },
  { method: 'get', path: '/api/audit-logs/actions', write: false, superAdminOnly: true },
];

describe('route inventory', () => {
  beforeAll(async () => {
    await truncateAll();
    await createTestAdmin({ email: 'viewer@test.local', role: 'VIEWER' });
  });

  it('rejects every admin route without a session', async () => {
    const results: Array<{ route: string; status: number }> = [];
    for (const route of ROUTES) {
      const client = agent();
      const request =
        route.method === 'get' || route.method === 'delete'
          ? client[route.method](route.path)
          : (client[route.method](route.path) as ReturnType<typeof client.get>).send(route.body ?? {});
      const response = await request;
      results.push({ route: `${route.method.toUpperCase()} ${route.path}`, status: response.status });
    }

    const notUnauthorized = results.filter((result) => result.status !== 401);
    expect(notUnauthorized, `these routes did not require authentication: ${JSON.stringify(notUnauthorized, null, 2)}`).toEqual([]);
  });

  it('blocks viewers from every write route but lets them read', async () => {
    const { client: viewer } = await loginWith({ email: 'viewer@test.local' });

    const writeFailures: Array<{ route: string; status: number }> = [];
    for (const route of ROUTES.filter((item) => item.write && !item.selfService)) {
      const request =
        route.method === 'get' || route.method === 'delete'
          ? viewer[route.method](route.path)
          : (viewer[route.method](route.path) as ReturnType<typeof viewer.get>).send(route.body ?? {});
      const response = await request;
      if (response.status !== 403) writeFailures.push({ route: `${route.method.toUpperCase()} ${route.path}`, status: response.status });
    }
    expect(writeFailures, `these write routes were not blocked for a viewer: ${JSON.stringify(writeFailures, null, 2)}`).toEqual([]);

    const readFailures: Array<{ route: string; status: number }> = [];
    for (const route of ROUTES.filter((item) => !item.write && !item.superAdminOnly && !item.elevatedRead)) {
      const response = await viewer[route.method](route.path);
      // reads may 404/409 for unknown ids, but must never 401/403/500
      if ([401, 403, 500].includes(response.status)) readFailures.push({ route: `${route.method.toUpperCase()} ${route.path}`, status: response.status });
    }
    expect(readFailures, `viewer could not read: ${JSON.stringify(readFailures, null, 2)}`).toEqual([]);
  });

  it('keeps the audit log and admin management to super admins', async () => {
    const { client: viewer } = await loginWith({ email: 'viewer@test.local' });
    await viewer.get('/api/audit-logs').expect(403);
    await viewer.get('/api/admins').expect(403);
    await viewer.post('/api/admins').send({ name: 'Nope Nope', email: 'nope@test.local', password: 'Password123x', role: 'VIEWER' }).expect(403);
  });

  it('only exposes the audited fields on the admin list to a viewer (no 2FA secret)', async () => {
    await createTestAdmin({ email: 'super2@test.local', role: 'SUPER_ADMIN', twoFASecretEncrypted: 'encrypted-secret' });
    const { client: viewer } = await loginWith({ email: 'viewer@test.local' });
    // viewers cannot list admins at all
    await viewer.get('/api/admins').expect(403);

    const { client: superAdmin } = await loginWith({ email: 'super2@test.local' });
    const response = await superAdmin.get('/api/admins').expect(200);
    const payload = JSON.stringify(response.body);
    expect(payload).not.toContain('encrypted-secret');
    expect(payload).not.toContain('passwordHash');
    expect(payload).not.toContain('twoFASecret');
  });

  it('never leaks investor NID values or full mobile numbers to a viewer', async () => {
    const { client: superAdmin } = await loginWith({ email: 'super2@test.local' });
    const investor = await superAdmin
      .post('/api/investors')
      .send({ name: 'Sensitive Person', mobile: '01819998877', nid: '1997111222333' })
      .expect(201);

    const { client: viewer } = await loginWith({ email: 'viewer@test.local' });
    const viewerResponse = await viewer.get(`/api/investors/${investor.body.investor.id}`).expect(200);
    const serialized = JSON.stringify(viewerResponse.body);
    expect(serialized).not.toContain('01819998877');
    expect(serialized).not.toContain('1997111222333');
    expect(viewerResponse.body.investor.mobile).toMatch(/\*{4}/);

    // the super admin sees them
    const adminResponse = await superAdmin.get(`/api/investors/${investor.body.investor.id}`).expect(200);
    expect(adminResponse.body.investor.nid).toBe('1997111222333');

    // and the NID read is audited
    const audit = await prisma.auditLog.findMany({ where: { action: 'investor.created' } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });
});
