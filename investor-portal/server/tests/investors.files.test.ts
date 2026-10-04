import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '../src/utils/auditActions';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith, request, app } from './helpers/http';

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function createInvestor(client: Awaited<ReturnType<typeof loginWith>>['client'], mobile = '01712345678') {
  const response = await client
    .post('/api/investors')
    .send({ name: 'File Test Investor', mobile })
    .expect(201);
  return response.body.investor.id as string;
}

describe('investor files: photo, private NID scan, signed URLs', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('uploads a profile photo (public asset)', async () => {
    await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
    const client = (await loginWith({ email: 'super@test.local' })).client;
    const investorId = await createInvestor(client);

    const response = await client
      .post(`/api/investors/${investorId}/photo`)
      .attach('photo', PNG, 'photo.png')
      .expect(201);

    expect(response.body.publicId).toMatch(/photo/);
    const row = await prisma.investor.findUnique({ where: { id: investorId } });
    expect(row!.photoPublicId).toBeTruthy();

    const audits = await auditRows(AuditAction.INVESTOR_PHOTO_UPDATED);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.oldValue).toMatchObject({ photoPublicId: null });
  });

  it('rejects non-image and oversized uploads', async () => {
    await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
    const client = (await loginWith({ email: 'super@test.local' })).client;
    const investorId = await createInvestor(client);

    await client
      .post(`/api/investors/${investorId}/photo`)
      .attach('photo', Buffer.from('%PDF-1.4 not an image'), 'scan.pdf')
      .expect(400);

    const big = Buffer.alloc(2 * 1024 * 1024 + 10, 1);
    const tooLarge = await client
      .post(`/api/investors/${investorId}/photo`)
      .attach('photo', big, 'big.png')
      .expect((res) => expect([400, 413]).toContain(res.status));
    expect(JSON.stringify(tooLarge.body)).toMatch(/2 MB|too large/i);
  });

  it('stores the NID scan privately and only exposes a short-lived signed URL', async () => {
    await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
    const client = (await loginWith({ email: 'super@test.local' })).client;
    const investorId = await createInvestor(client);

    await client.post(`/api/investors/${investorId}/nid-scan`).attach('nidScan', PNG, 'nid.png').expect(201);
    await client.post(`/api/investors/${investorId}/nid-scan`).expect(400); // no file

    const row = await prisma.investor.findUnique({ where: { id: investorId } });
    expect(row!.nidPublicId).toMatch(/nid/);

    // the detail response never contains the raw storage id or a direct link
    const detail = await client.get(`/api/investors/${investorId}`).expect(200);
    expect(JSON.stringify(detail.body)).not.toContain(row!.nidPublicId!);
    expect(detail.body.investor.hasNidScan).toBe(true);

    const signed = await client.get(`/api/investors/${investorId}/nid-scan-url`).expect(200);
    expect(signed.body.url).toContain('sig=');
    expect(signed.body.expiresInSeconds).toBe(300);
    expect(await auditRows(AuditAction.INVESTOR_NID_VIEWED)).toHaveLength(1);

    // the signed URL works...
    await request(app).get(signed.body.url).expect(200);
    // ...but tampering with it does not
    await request(app).get(signed.body.url.replace(/sig=[^&]+/, 'sig=deadbeef')).expect(404);
    // ...and neither does an expired one
    const expired = signed.body.url.replace(/exp=\d+/, 'exp=1');
    await request(app).get(expired).expect(404);
  });

  it('blocks non SUPER_ADMIN roles from NID scans', async () => {
    await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
    const superClient = (await loginWith({ email: 'super@test.local' })).client;
    const investorId = await createInvestor(superClient);
    await superClient.post(`/api/investors/${investorId}/nid-scan`).attach('nidScan', PNG, 'nid.png').expect(201);

    for (const role of ['ACCOUNTANT', 'VIEWER'] as const) {
      await createTestAdmin({ email: `${role.toLowerCase()}@test.local`, role });
      const client = (await loginWith({ email: `${role}@test.local` })).client;
      await client.get(`/api/investors/${investorId}/nid-scan-url`).expect(403);
      await client.post(`/api/investors/${investorId}/nid-scan`).attach('nidScan', PNG, 'nid.png').expect(403);
    }
  });
});
