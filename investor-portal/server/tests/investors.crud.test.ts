import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '../src/utils/auditActions';
import { hmac } from '../src/utils/encryption';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith, request, app } from './helpers/http';

async function asSuperAdmin() {
  await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
  return (await loginWith({ email: 'super@test.local' })).client;
}

async function asAccountant() {
  await createTestAdmin({ email: 'accountant@test.local', role: 'ACCOUNTANT' });
  return (await loginWith({ email: 'accountant@test.local' })).client;
}

const investorPayload = {
  name: 'Md. Rahim Uddin',
  mobile: '01712345678',
  nid: '1990123456789',
  address: 'Mirpur 10, Dhaka',
  nominees: [
    { name: 'Fatema Begum', relation: 'Wife', mobile: '01711111111', nid: '1992111222333', sharePercent: 60 },
    { name: 'Sadia Uddin', relation: 'Daughter', mobile: '01711111112', sharePercent: 40 },
  ],
};

describe('investors: CRUD, uniqueness, nominees, soft delete', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('creates an investor with nominees and stores the NID encrypted', async () => {
    const client = await asSuperAdmin();
    const response = await client.post('/api/investors').send(investorPayload).expect(201);

    expect(response.body.investor.name).toBe('Md. Rahim Uddin');
    expect(response.body.investor.nominees).toHaveLength(2);
    expect(response.body.investor.nid).toBe('1990123456789');
    expect(response.body.investor.summary.contracted).toBe('0');

    const row = await prisma.investor.findUnique({ where: { mobile: '01712345678' } });
    expect(row).toBeTruthy();
    expect(row!.nidEncrypted).toBeTruthy();
    expect(row!.nidEncrypted).not.toContain('1990123456789'); // never stored in clear text
    expect(row!.nidEncrypted!.startsWith('v1:')).toBe(true);
    expect(row!.nidHash).toBe(hmac('1990123456789'));

    expect(await auditRows(AuditAction.INVESTOR_CREATED)).toHaveLength(1);
  });

  it('rejects duplicate mobiles and duplicate NIDs', async () => {
    const client = await asSuperAdmin();
    await client.post('/api/investors').send(investorPayload).expect(201);

    const duplicateMobile = await client
      .post('/api/investors')
      .send({ ...investorPayload, nid: '1990111111111' })
      .expect(409);
    expect(duplicateMobile.body.error.code).toBe('CONFLICT');

    const duplicateNid = await client
      .post('/api/investors')
      .send({ ...investorPayload, mobile: '01912345678' })
      .expect(409);
    expect(duplicateNid.body.error.message).toMatch(/NID/i);
  });

  it('enforces at most 3 nominees and shares totalling 100%', async () => {
    const client = await asSuperAdmin();

    const tooMany = await client
      .post('/api/investors')
      .send({
        ...investorPayload,
        nominees: [
          { name: 'A One', relation: 'Wife', mobile: '01711111111', sharePercent: 25 },
          { name: 'B Two', relation: 'Son', mobile: '01711111112', sharePercent: 25 },
          { name: 'C Three', relation: 'Daughter', mobile: '01711111113', sharePercent: 25 },
          { name: 'D Four', relation: 'Father', mobile: '01711111114', sharePercent: 25 },
        ],
      })
      .expect(400);
    expect(tooMany.body.error.details?.some((d: { message: string }) => /at most 3/i.test(d.message))).toBe(true);

    const badShares = await client
      .post('/api/investors')
      .send({
        ...investorPayload,
        nominees: [
          { name: 'A One', relation: 'Wife', mobile: '01711111111', sharePercent: 30 },
          { name: 'B Two', relation: 'Son', mobile: '01711111112', sharePercent: 30 },
        ],
      })
      .expect(400);
    expect(JSON.stringify(badShares.body)).toMatch(/100/);
  });

  it('validates Bangladeshi mobile numbers', async () => {
    const client = await asSuperAdmin();
    await client.post('/api/investors').send({ ...investorPayload, mobile: '12345' }).expect(400);
    const normalised = await client
      .post('/api/investors')
      .send({ ...investorPayload, mobile: '+880 1712-345678' })
      .expect(201);
    expect(normalised.body.investor.mobile).toBe('01712345678');
  });

  it('masks sensitive fields for non SUPER_ADMIN roles', async () => {
    const admin = await asSuperAdmin();
    const created = await admin.post('/api/investors').send(investorPayload).expect(201);

    const accountant = await asAccountant();
    const list = await accountant.get('/api/investors').expect(200);
    expect(list.body.items[0].mobile).toMatch(/^01712\*+78$/);
    // NID values are never returned to roles without investor:sensitive:read
    expect(list.body.items[0].nid).toBeNull();
    expect(list.body.items[0].hasNid).toBe(true);

    const detail = await accountant.get(`/api/investors/${created.body.investor.id}`).expect(200);
    expect(detail.body.investor.mobile).toBe('01712****78');
    expect(detail.body.investor.nid).toBeNull();
    expect(detail.body.investor.nominees[0].mobile).toBe('01711****11');
    expect(detail.body.investor.nominees[0].nid).toBeNull();

    // ...while a super admin sees the real values
    const asSuper = await admin.get(`/api/investors/${created.body.investor.id}`).expect(200);
    expect(asSuper.body.investor.nid).toBe('1990123456789');
    expect(asSuper.body.investor.mobile).toBe('01712345678');
    expect(asSuper.body.investor.nominees[0].nid).toBe('1992111222333');
  });

  it('only SUPER_ADMIN may change nominees', async () => {
    const admin = await asSuperAdmin();
    const created = await admin.post('/api/investors').send(investorPayload).expect(201);
    const investorId = created.body.investor.id;

    const accountant = await asAccountant();
    const forbidden = await accountant
      .put(`/api/investors/${investorId}/nominees`)
      .send({ nominees: [{ name: 'Only One', relation: 'Wife', mobile: '01711111111', sharePercent: 100 }] })
      .expect(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');

    // an accountant may still create an investor WITHOUT nominees
    await accountant
      .post('/api/investors')
      .send({ name: 'No Nominee Investor', mobile: '01812345678' })
      .expect(201);
    // ... but not with them
    await accountant
      .post('/api/investors')
      .send({
        name: 'Nominee Investor',
        mobile: '01812345679',
        nominees: [{ name: 'Someone', relation: 'Wife', mobile: '01711111119', sharePercent: 100 }],
      })
      .expect(403);
  });

  it('replaces the nominee list atomically and audits it', async () => {
    const client = await asSuperAdmin();
    const created = await client.post('/api/investors').send(investorPayload).expect(201);
    const investorId = created.body.investor.id;

    const updated = await client
      .put(`/api/investors/${investorId}/nominees`)
      .send({
        nominees: [
          { name: 'Fatema Begum', relation: 'Wife', mobile: '01711111111', sharePercent: 50, id: created.body.investor.nominees[0].id },
          { name: 'New Son', relation: 'Son', mobile: '01711111113', sharePercent: 50 },
        ],
      })
      .expect(200);

    expect(updated.body.investor.nominees).toHaveLength(2);
    expect(updated.body.investor.nominees.map((n: { name: string }) => n.name).sort()).toEqual(['Fatema Begum', 'New Son']);
    expect(await prisma.nominee.count({ where: { investorId } })).toBe(2);
    expect(await auditRows(AuditAction.NOMINEE_UPDATED)).toHaveLength(1);
  });

  it('rejects nominee sets whose shares do not total 100%', async () => {
    const client = await asSuperAdmin();
    const created = await client.post('/api/investors').send(investorPayload).expect(201);
    const response = await client
      .put(`/api/investors/${created.body.investor.id}/nominees`)
      .send({ nominees: [{ name: 'A One', relation: 'Wife', mobile: '01711111111', sharePercent: 70 }] })
      .expect(400);
    expect(JSON.stringify(response.body)).toMatch(/100/);
  });

  it('updates an investor and audits the previous values', async () => {
    const client = await asSuperAdmin();
    const created = await client.post('/api/investors').send(investorPayload).expect(201);

    await client
      .patch(`/api/investors/${created.body.investor.id}`)
      .send({ name: 'Md. Rahim Uddin (updated)', address: 'Dhanmondi, Dhaka' })
      .expect(200);

    const audits = await auditRows(AuditAction.INVESTOR_UPDATED);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.oldValue).toMatchObject({ name: 'Md. Rahim Uddin' });
    expect(audits[0]!.newValue).toMatchObject({ name: 'Md. Rahim Uddin (updated)' });
  });

  it('soft deletes (deactivates) instead of removing data', async () => {
    const client = await asSuperAdmin();
    const created = await client.post('/api/investors').send(investorPayload).expect(201);
    const investorId = created.body.investor.id;

    await client.post(`/api/investors/${investorId}/deactivate`).expect(200);
    const row = await prisma.investor.findUnique({ where: { id: investorId } });
    expect(row).toBeTruthy();
    expect(row!.status).toBe('INACTIVE');
    expect(await auditRows(AuditAction.INVESTOR_DEACTIVATED)).toHaveLength(1);

    const inactive = await client.get('/api/investors?status=INACTIVE').expect(200);
    expect(inactive.body.items).toHaveLength(1);

    await client.post(`/api/investors/${investorId}/reactivate`).expect(200);
    expect((await prisma.investor.findUnique({ where: { id: investorId } }))!.status).toBe('ACTIVE');
  });

  it('paginates, searches and sorts', async () => {
    const client = await asSuperAdmin();
    for (let i = 0; i < 5; i += 1) {
      await client
        .post('/api/investors')
        .send({ name: `Investor ${i}`, mobile: `0171234567${i}`, address: i % 2 === 0 ? 'Dhaka' : 'Chattogram' })
        .expect(201);
    }

    const page = await client.get('/api/investors?page=2&pageSize=2&sortBy=name&sortDir=asc').expect(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total).toBe(5);
    expect(page.body.totalPages).toBe(3);

    const search = await client.get('/api/investors?search=Investor 3').expect(200);
    expect(search.body.items).toHaveLength(1);

    const byAddress = await client.get('/api/investors?search=Chattogram').expect(200);
    expect(byAddress.body.items.length).toBeGreaterThan(0);
  });

  it('404s for an unknown investor', async () => {
    const client = await asSuperAdmin();
    await client.get('/api/investors/00000000-0000-0000-0000-000000000000').expect(404);
    await client.get('/api/investors/not-a-uuid').expect(400);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/investors').expect(401);
    await request(app).post('/api/investors').send(investorPayload).expect(401);
  });
});
