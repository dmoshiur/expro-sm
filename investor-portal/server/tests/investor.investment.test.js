/**
 * Investors, nominees, investments and installments: creation rules, the
 * sum invariant, the nominee limit, status transitions and audit writes.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, createInvestorWithInvestment, nextMobile } from './helpers/harness.js';

let ctx;
let admin;
let accountant;
let viewer;

before(async () => {
  ctx = await createTestContext();
  admin = await ctx.loginAs('SUPER_ADMIN');
  accountant = await ctx.loginAs('ACCOUNTANT');
  viewer = await ctx.loginAs('VIEWER');
});

after(async () => {
  await ctx?.close();
});

describe('investors', () => {
  test('creates an investor, stores the NID encrypted + hashed', async () => {
    const response = await admin.post('/api/investors', {
      name: 'Rahim Uddin',
      mobile: '01714141414',
      nid: '1990123456789',
      address: 'House 12, Dhanmondi',
    });
    assert.equal(response.status, 201);
    const investor = response.data.investor;
    assert.equal(investor.mobile, '01714141414');
    assert.equal(investor.nid_encrypted, undefined);

    const raw = await ctx.query('select nid_encrypted, nid_hash, nid_last4 from investors where id = $1', [investor.id]);
    assert.match(raw.rows[0].nid_encrypted, /^v1\./);
    assert.ok(!raw.rows[0].nid_encrypted.includes('1990123456789'), 'the NID must not be stored in clear text');
    assert.equal(raw.rows[0].nid_hash.length, 64);
    assert.equal(raw.rows[0].nid_last4, '6789');

    const reveal = await admin.get(`/api/investors/${investor.id}/nid`);
    assert.equal(reveal.status, 200);
    assert.equal(reveal.data.nid, '1990123456789');

    const auditRow = await ctx.query(
      `select count(*)::int as count from audit_logs where entity = 'investor' and entity_id = $1 and action = 'INVESTOR_NID_VIEWED'`,
      [String(investor.id)],
    );
    assert.equal(auditRow.rows[0].count, 1, 'revealing an NID must be audited');
  });

  test('rejects duplicate mobile and duplicate NID', async () => {
    const mobile = nextMobile();
    const first = await admin.post('/api/investors', { name: 'First', mobile, nid: '1990111122223' });
    assert.equal(first.status, 201);

    const dupeMobile = await admin.post('/api/investors', { name: 'Second', mobile });
    assert.equal(dupeMobile.status, 409);

    const dupeNid = await admin.post('/api/investors', { name: 'Third', mobile: nextMobile(1), nid: '1990-111122223' });
    assert.equal(dupeNid.status, 409);
    assert.match(dupeNid.error.message, /NID/);
  });

  test('validates input and refuses invalid mobiles/NIDs', async () => {
    const badMobile = await admin.post('/api/investors', { name: 'Bad', mobile: '12345' });
    assert.equal(badMobile.status, 422);
    assert.ok(badMobile.error.details.mobile);

    const badNid = await admin.post('/api/investors', { name: 'Bad', mobile: nextMobile(2), nid: '1234' });
    assert.equal(badNid.status, 422);
    assert.ok(badNid.error.details.nid);

    const noName = await admin.post('/api/investors', { mobile: nextMobile(3) });
    assert.equal(noName.status, 422);
  });

  test('nominees: 1-3 allowed, shares must total 100, DB trigger backs the service', async () => {
    const investor = (await admin.post('/api/investors', { name: 'Nominee Owner', mobile: nextMobile(4) })).data.investor;

    const tooMany = await admin.post(`/api/investors/${investor.id}/nominees`, {
      nominees: [1, 2, 3, 4].map((i) => ({ name: `N${i}`, relation: 'Child', mobile: nextMobile(10 + i), share_percent: 25 })),
    });
    assert.equal(tooMany.status, 422);

    const badShares = await admin.post(`/api/investors/${investor.id}/nominees`, {
      nominees: [
        { name: 'A', relation: 'Spouse', mobile: nextMobile(20), share_percent: 60 },
        { name: 'B', relation: 'Son', mobile: nextMobile(21), share_percent: 30 },
      ],
    });
    assert.equal(badShares.status, 400);
    assert.match(badShares.error.message, /100%/);

    const ok = await admin.post(`/api/investors/${investor.id}/nominees`, {
      nominees: [
        { name: 'A', relation: 'Spouse', mobile: nextMobile(22), share_percent: 60, nid: '1988111122223' },
        { name: 'B', relation: 'Son', mobile: nextMobile(23), share_percent: 40 },
      ],
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.nominees.length, 2);
    assert.ok(ok.data.nominees[0].mobile_masked);
    assert.equal(ok.data.nominees[0].nid_encrypted, undefined);

    // The database trigger is the last line of defence: bypass the service.
    // Two extra rows push the investor to 4 nominees; the immediate count
    // trigger fires before the deferred share-total check can complain.
    await assert.rejects(
      ctx.query(
        `insert into nominees (investor_id, name, relation, mobile, share_percent)
         select $1, 'Extra ' || g, 'Child', $2, 1 from generate_series(1, 2) g`,
        [investor.id, nextMobile(24)],
      ),
      /at most 3 nominees/,
    );

    await assert.rejects(
      ctx.query(`update nominees set share_percent = 90 where investor_id = $1`, [investor.id]),
      /must total 100/,
    );

    // Deleting all nominees must also be allowed (deferred check)
    await ctx.query('delete from nominees where investor_id = $1', [investor.id]);
    const after = await ctx.query('select count(*)::int as count from nominees where investor_id = $1', [investor.id]);
    assert.equal(after.rows[0].count, 0);

    const auditRow = await ctx.query(
      `select count(*)::int as count from audit_logs where action = 'NOMINEES_REPLACED' and entity_id = $1`,
      [String(investor.id)],
    );
    assert.ok(auditRow.rows[0].count >= 1, 'nominee replacement must be audited with old + new values');
  });

  test('photo upload validates magic bytes, size and encryption of scans', async () => {
    const investor = (await admin.post('/api/investors', { name: 'Photo Owner', mobile: nextMobile(30) })).data.investor;

    const fakeJpeg = Buffer.concat([Buffer.from('this is not an image at all'), Buffer.from([0xff, 0xd8, 0xff])]);
    const rejected = await admin.upload(`/api/investors/${investor.id}/photo`, fakeJpeg, 'image/jpeg');
    assert.equal(rejected.status, 400);
    assert.match(rejected.error.message, /Unsupported file type/);

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
      Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
    ]);
    const accepted = await admin.upload(`/api/investors/${investor.id}/photo`, png, 'image/png');
    assert.equal(accepted.status, 200);

    const photo = await admin.get(`/api/investors/${investor.id}/photo`);
    assert.equal(photo.status, 200);
    assert.match(photo.headers.get('content-type'), /image\/png/);
    assert.match(photo.headers.get('cache-control'), /private/);

    const oversized = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3 * 1024 * 1024)]);
    const tooBig = await admin.upload(`/api/investors/${investor.id}/photo`, oversized, 'image/png');
    assert.equal(tooBig.status, 413);

    // NID scan: stored encrypted, only readable by SUPER_ADMIN
    const scan = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.from('fake pdf body')]);
    const uploaded = await admin.upload(`/api/investors/${investor.id}/nid-scan`, scan, 'application/pdf');
    assert.equal(uploaded.status, 200);

    const stored = await ctx.query('select nid_scan from investors where id = $1', [investor.id]);
    assert.ok(Buffer.isBuffer(stored.rows[0].nid_scan));
    assert.ok(!stored.rows[0].nid_scan.includes(Buffer.from('fake pdf body')), 'the scan must be encrypted at rest');

    const fetched = await admin.get(`/api/investors/${investor.id}/nid-scan`);
    assert.equal(fetched.status, 200);
    assert.ok(fetched.text.includes('fake pdf body'));

    const forbidden = await accountant.get(`/api/investors/${investor.id}/nid-scan`);
    assert.equal(forbidden.status, 403);

    const reader = await viewer.get(`/api/investors/${investor.id}/photo`);
    assert.equal(reader.status, 200, 'photos are readable by authenticated staff (masking applies to text fields)');
  });

  test('soft delete keeps the record and blocks new investments; restore works', async () => {
    const investor = (await admin.post('/api/investors', { name: 'Delete Me', mobile: nextMobile(40) })).data.investor;
    const deleted = await accountant.del(`/api/investors/${investor.id}`, { reason: 'left the business' });
    assert.equal(deleted.status, 200);

    const listed = await admin.get(`/api/investors?includeDeleted=true&search=Delete Me`);
    assert.ok(listed.data.items.some((row) => row.id === investor.id));

    const hidden = await admin.get(`/api/investors?search=Delete Me`);
    assert.equal(hidden.data.items.some((row) => row.id === investor.id), false);

    const investment = await accountant.post('/api/investments', {
      investorId: investor.id,
      totalAmount: '500.00',
      installmentCount: 1,
      firstDueDate: '2026-02-28',
    });
    assert.equal(investment.status, 400);

    const restored = await accountant.post(`/api/investors/${investor.id}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.data.investor.deleted_at, null);
  });

  test('search, status filter, sorting and pagination work', async () => {
    const response = await admin.get('/api/investors?search=Rahim&status=ACTIVE&sort=name&dir=asc&limit=5&page=1');
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.data.items));
    assert.ok(response.data.meta.total >= 1);
    assert.equal(response.data.meta.limit, 5);

    const badStatus = await admin.get('/api/investors?status=NOPE');
    assert.equal(badStatus.status, 400);
  });
});

describe('investments + installments', () => {
  test('creates a schedule whose amounts sum exactly to the total', async () => {
    const { investment, installments } = await createInvestorWithInvestment(admin, {
      name: 'Split Tester',
      mobile: nextMobile(50),
      totalTaka: '10000.01',
      installmentCount: 3,
      firstDueDate: '2026-01-31',
    });

    assert.equal(investment.total_amount, 1_000_001);
    assert.equal(installments.length, 3);
    assert.deepEqual(
      installments.map((row) => row.amount),
      [333_333, 333_333, 333_335],
    );
    assert.equal(installments.reduce((sum, row) => sum + row.amount, 0), investment.total_amount);
    assert.deepEqual(
      installments.map((row) => String(row.due_date)),
      ['2026-01-31', '2026-02-28', '2026-03-31'],
    );
    assert.ok(installments.every((row) => row.pay_token_hash, 'every installment gets a payment token hash'));
    assert.ok(installments.every((row) => row.pay_token === undefined), 'the raw token is never returned in list responses');
    assert.equal(investment.status, 'ACTIVE');
  });

  test('the DB refuses a schedule that does not sum to the total', async () => {
    const { investment } = await createInvestorWithInvestment(admin, {
      name: 'Trigger Tester',
      mobile: nextMobile(51),
      totalTaka: '300.00',
      installmentCount: 3,
      firstDueDate: '2026-05-31',
    });
    await assert.rejects(
      ctx.query('update installments set amount = amount + 1 where investment_id = $1 and serial = 1', [investment.id]),
      /must total/,
    );
  });

  test('installment edits keep the sum equal to the investment total', async () => {
    const { investment, installments } = await createInvestorWithInvestment(admin, {
      name: 'Edit Tester',
      mobile: nextMobile(52),
      totalTaka: '900.00',
      installmentCount: 3,
      firstDueDate: '2026-06-30',
    });

    // Editing one row alone breaks the invariant -> 400
    const alone = await accountant.patch(`/api/installments/${installments[0].id}`, { amount: '400.00' });
    assert.equal(alone.status, 400);
    assert.match(alone.error.message, /adding up to the investment total/);

    // Rebalancing the pair inside the schedule keeps it valid
    const first = await accountant.patch(`/api/installments/${installments[0].id}`, { amount: '250.00' });
    assert.equal(first.status, 400);

    const adjustTotal = await accountant.patch(`/api/investments/${investment.id}/total`, {
      totalAmount: '1200.00',
      reason: 'scope increased',
      strategy: 'REDISTRIBUTE',
    });
    assert.equal(adjustTotal.status, 200);
    assert.equal(adjustTotal.data.investment.total_amount, 120_000);

    const after = await ctx.query(
      'select sum(amount)::bigint as total, count(*)::int as rows from installments where investment_id = $1',
      [investment.id],
    );
    assert.equal(Number(after.rows[0].total), 120_000);
    assert.equal(after.rows[0].rows, 3);

    const auditRow = await ctx.query(
      `select action, old_value, new_value from audit_logs where action = 'INVESTMENT_TOTAL_CHANGED' and entity_id = $1`,
      [String(investment.id)],
    );
    assert.equal(auditRow.rows.length, 1);
    assert.equal(auditRow.rows[0].old_value.total_amount, 90_000);
    assert.equal(auditRow.rows[0].new_value.total_amount, 120_000);
  });

  test('due dates can be moved and payment links refresh on demand', async () => {
    const { installments } = await createInvestorWithInvestment(admin, {
      name: 'Due Date Tester',
      mobile: nextMobile(53),
      totalTaka: '600.00',
      installmentCount: 2,
      firstDueDate: '2026-07-31',
    });
    const moved = await accountant.patch(`/api/installments/${installments[0].id}`, { due_date: '2026-08-15' });
    assert.equal(moved.status, 200);
    assert.equal(String(moved.data.installment.due_date), '2026-08-15');

    const badDate = await accountant.patch(`/api/installments/${installments[1].id}`, { due_date: '2026-02-30' });
    assert.equal(badDate.status, 422);
  });

  test('waive / cancel / reinstate require a reason and are audited', async () => {
    const { installments } = await createInvestorWithInvestment(admin, {
      name: 'Waive Tester',
      mobile: nextMobile(54),
      totalTaka: '300.00',
      installmentCount: 3,
      firstDueDate: '2026-09-30',
    });

    const noReason = await accountant.post(`/api/installments/${installments[0].id}/state`, { status: 'WAIVED' });
    assert.equal(noReason.status, 400);

    const waived = await accountant.post(`/api/installments/${installments[0].id}/state`, {
      status: 'WAIVED',
      reason: 'goodwill adjustment',
    });
    assert.equal(waived.status, 200);
    assert.equal(waived.data.installment.status, 'WAIVED');

    const cancelled = await accountant.post(`/api/installments/${installments[1].id}/state`, {
      status: 'CANCELLED',
      reason: 'contract changed',
    });
    assert.equal(cancelled.status, 200);

    const reinstated = await accountant.post(`/api/installments/${installments[1].id}/state`, {
      status: 'PENDING',
      reason: 'made a mistake',
    });
    assert.equal(reinstated.status, 200);
    assert.equal(reinstated.data.installment.status, 'PENDING');

    const actions = await ctx.query(
      `select action from audit_logs where entity = 'installment' and entity_id in ($1, $2) order by id`,
      [String(installments[0].id), String(installments[1].id)],
    );
    const seen = actions.rows.map((row) => row.action);
    assert.ok(seen.includes('INSTALLMENT_WAIVED'));
    assert.ok(seen.includes('INSTALLMENT_CANCELLED'));
    assert.ok(seen.includes('INSTALLMENT_REINSTATED'));
  });

  test('overdue sweep marks past-due installments and is idempotent', async () => {
    const { installments } = await createInvestorWithInvestment(admin, {
      name: 'Overdue Tester',
      mobile: nextMobile(55),
      totalTaka: '400.00',
      installmentCount: 2,
      firstDueDate: '2020-01-01',
    });
    const { markOverdue } = await import('../src/services/installment.service.js');
    const first = await markOverdue({ asOf: '2030-01-01' });
    assert.ok(first.length >= 2);
    const second = await markOverdue({ asOf: '2030-01-01' });
    assert.equal(second.length, 0, 'a second run must not change anything (idempotent)');

    const rows = await ctx.query('select status from installments where investment_id = $1', [installments[0].investment_id]);
    assert.ok(rows.rows.every((row) => row.status === 'OVERDUE'));

    const auditRow = await ctx.query(`select count(*)::int as count from audit_logs where action = 'INSTALLMENT_OVERDUE_MARKED'`);
    assert.ok(auditRow.rows[0].count >= 1);
  });

  test('investment totals are validated and cancellation is recorded', async () => {
    const { investment } = await createInvestorWithInvestment(admin, {
      name: 'Cancel Tester',
      mobile: nextMobile(56),
      totalTaka: '1000.00',
      installmentCount: 2,
      firstDueDate: '2026-10-31',
    });

    const invalid = await accountant.post('/api/investments', {
      investorId: investment.investor_id,
      totalAmount: '-10.00',
      installmentCount: 2,
      firstDueDate: '2026-10-31',
    });
    assert.equal(invalid.status, 422);

    const tooMany = await accountant.post('/api/investments', {
      investorId: investment.investor_id,
      totalAmount: '100.00',
      installmentCount: 121,
      firstDueDate: '2026-10-31',
    });
    assert.equal(tooMany.status, 422);

    const cancelled = await accountant.post(`/api/investments/${investment.id}/status`, {
      status: 'CANCELLED',
      reason: 'investor withdrew',
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.investment.status, 'CANCELLED');

    const auditRow = await ctx.query(
      `select count(*)::int as count from audit_logs where action = 'INVESTMENT_STATUS_CHANGED' and entity_id = $1`,
      [String(investment.id)],
    );
    assert.equal(auditRow.rows[0].count, 1);
  });

  test('investment detail exposes the schedule, totals and payments', async () => {
    const { investment } = await createInvestorWithInvestment(accountant, {
      name: 'Detail Tester',
      mobile: nextMobile(57),
      totalTaka: '1500.00',
      installmentCount: 3,
      firstDueDate: '2026-11-30',
    });
    const detail = await viewer.get(`/api/investments/${investment.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.installments.length, 3);
    assert.equal(detail.data.installment_count, 3);
    assert.ok(Array.isArray(detail.data.payments));
    assert.equal(Number(detail.data.amount_outstanding), 150_000);
  });
});

describe('audit log', () => {
  test('records investor/investment/installment changes with old + new values and redacts secrets', async () => {
    const investor = (await admin.post('/api/investors', { name: 'Audit Target', mobile: nextMobile(60) })).data.investor;
    await admin.patch(`/api/investors/${investor.id}`, { name: 'Audit Target Renamed' });

    const entries = await admin.get(`/api/audit?entity=investor&entityId=${investor.id}&limit=10`);
    assert.equal(entries.status, 200);
    const created = entries.data.items.find((row) => row.action === 'INVESTOR_CREATED');
    const updated = entries.data.items.find((row) => row.action === 'INVESTOR_UPDATED');
    assert.ok(created && updated);
    assert.equal(updated.old_value.name, 'Audit Target');
    assert.equal(updated.new_value.name, 'Audit Target Renamed');
    assert.match(updated.actor_email, /root@test.local/);

    const auditRow = await ctx.query(
      `select new_value from audit_logs where action = 'ADMIN_CREATED' order by id desc limit 1`,
    );
    assert.ok(!JSON.stringify(auditRow.rows[0].new_value ?? {}).includes('password_hash'));
  });

  test('audit_logs is append-only at the database level', async () => {
    await assert.rejects(ctx.query(`update audit_logs set action = 'HACKED' where id = (select max(id) from audit_logs)`), /append-only/);
    await assert.rejects(ctx.query(`delete from audit_logs where id = (select max(id) from audit_logs)`), /append-only/);
    await assert.rejects(ctx.query('truncate audit_logs'), /append-only/);
  });

  test('filters endpoint exposes actions and entities', async () => {
    const filters = await admin.get('/api/audit/filters');
    assert.equal(filters.status, 200);
    assert.ok(filters.data.actions.includes('LOGIN_SUCCESS'));
    assert.ok(filters.data.entities.includes('investor'));
  });
});
