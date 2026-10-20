/**
 * Investor experience integration tests (migration 003):
 *  - NID / mobile normalisation on create + granular 422 details
 *  - membership approval, wallet ledger + self-service requests + freeze
 *  - document slots, upload permissions and Super-Admin review
 *  - support tickets shared between the portal and the staff inbox
 *  - printable statement / certificate
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, makeClient, createInvestorWithInvestment, nextMobile } from './helpers/harness.js';

let ctx;
let superAdmin;
let accountant;

const TEMP_PASSWORD = 'TempPass2026x';
const FINAL_PASSWORD = 'MyOwnPass2026';
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let nidCounter = 0;
function nextNid() {
  nidCounter += 1;
  return `1990${String(100000000 + nidCounter).slice(-9)}`;
}

before(async () => {
  ctx = await createTestContext();
  superAdmin = await ctx.loginAs('SUPER_ADMIN');
  accountant = await ctx.loginAs('ACCOUNTANT');
});

after(async () => {
  await ctx?.close();
});

async function clientForPortal() {
  const { resetRateLimits } = await import('../src/middleware/security.js');
  resetRateLimits();
  return makeClient(ctx.baseUrl);
}

async function loginReady(loginId, tempPassword, finalPassword = FINAL_PASSWORD) {
  const client = await clientForPortal();
  const login = await client.post('/api/portal/auth/login', { loginId, password: tempPassword });
  assert.equal(login.status, 200, `portal login failed: ${JSON.stringify(login.body)}`);
  if (login.data.investor.must_change_password) {
    const changed = await client.post('/api/portal/auth/change-password', {
      currentPassword: tempPassword,
      newPassword: finalPassword,
    });
    assert.equal(changed.status, 200, `change-password failed: ${JSON.stringify(changed.body)}`);
  }
  return client;
}

/** New investor with portal access already set up, plus an optional investment. */
async function makePortalInvestor(overrides = {}) {
  const { investor, installments } = await createInvestorWithInvestment(superAdmin, {
    mobile: nextMobile(),
    createInvestment: overrides.createInvestment ?? false,
    nominees: overrides.nominees,
    ...overrides,
  });
  await superAdmin.post(`/api/investors/${investor.id}/membership`, { status: 'APPROVED' });
  const set = await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });
  assert.equal(set.status, 200, `portal password failed: ${JSON.stringify(set.body)}`);
  const portal = await loginReady(investor.mobile, TEMP_PASSWORD);
  return { investor, portal, installments };
}

describe('investor create/update validation', () => {
  test('accepts formatted NID, +880 mobile and a Bangla name, then normalises them', async () => {
    const nid = nextNid();
    const formatted = `${nid.slice(0, 4)}-${nid.slice(4, 10)}-${nid.slice(10)}`;
    const mobile = `+880 ${nextMobile().slice(1, 4)}-${nextMobile().slice(4, 11)}`;
    const response = await superAdmin.post('/api/investors', {
      name: 'Normalisation Test',
      name_bangla: 'নরমালাইজেশন',
      mobile,
      nid: formatted,
      present_address: 'Dhanmondi, Dhaka',
      permanent_address: 'Shibganj, Chapainawabganj',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.match(response.data.investor.mobile, /^01[3-9]\d{8}$/);
    assert.equal(response.data.investor.membership_status, 'PENDING');
    assert.equal(response.data.investor.name_bangla, 'নরমালাইজেশন');
    assert.equal(response.data.investor.nid_last4, nid.slice(-4));
  });

  test('rejects a 14-digit NID with a field-level 422 and keeps the old NID on update', async () => {
    const { investor } = await createInvestorWithInvestment(superAdmin, { mobile: nextMobile(), createInvestment: false });
    const bad = await superAdmin.patch(`/api/investors/${investor.id}`, { nid: '1990-123456-7890' });
    assert.equal(bad.status, 422);
    assert.match(bad.error.details.nid, /10, 13 or 17/);

    const mobileBad = await superAdmin.post('/api/investors', { name: 'Bad Mobile', mobile: '12345' });
    assert.equal(mobileBad.status, 422);
    assert.match(mobileBad.error.details.mobile, /valid Bangladeshi mobile/);

    const nomineeBad = await superAdmin.post('/api/investors', {
      name: 'Bad Nominee',
      mobile: nextMobile(),
      nominees: [{ name: '', relation: '', mobile: 'x', share_percent: 0 }],
    });
    assert.equal(nomineeBad.status, 422);
    assert.ok(nomineeBad.error.details['nominees[0].name']);
    assert.ok(nomineeBad.error.details['nominees[0].share_percent']);
  });

  test('partial profile updates (inline edit) keep other fields intact', async () => {
    const { investor } = await createInvestorWithInvestment(superAdmin, { mobile: nextMobile(), createInvestment: false });
    const patched = await superAdmin.patch(`/api/investors/${investor.id}`, {
      name_bangla: 'নাম',
      present_address: 'House 1, Road 2',
      permanent_address: 'Village, Upazila',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.investor.name_bangla, 'নাম');
    assert.equal(patched.data.investor.present_address, 'House 1, Road 2');
    assert.equal(patched.data.investor.mobile, investor.mobile);
  });
});

describe('membership approval', () => {
  test('new investors start PENDING and only a Super Admin can decide', async () => {
    const { investor } = await createInvestorWithInvestment(superAdmin, { mobile: nextMobile(), createInvestment: false });
    assert.equal(investor.membership_status, 'PENDING');

    const denied = await accountant.post(`/api/investors/${investor.id}/membership`, { status: 'APPROVED' });
    assert.equal(denied.status, 403);

    const rejected = await superAdmin.post(`/api/investors/${investor.id}/membership`, { status: 'REJECTED' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.investor.membership_status, 'REJECTED');

    const approved = await superAdmin.post(`/api/investors/${investor.id}/membership`, {
      status: 'APPROVED',
      note: 'Documents verified',
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.investor.membership_status, 'APPROVED');
  });
});

describe('wallet ledger', () => {
  test('manual entry, live summary and a portal withdrawal request approved by staff', async () => {
    const { investor } = await createInvestorWithInvestment(superAdmin, { mobile: nextMobile(), createInvestment: false });
    await superAdmin.post(`/api/investors/${investor.id}/membership`, { status: 'APPROVED' });

    const entry = await accountant.post(`/api/investors/${investor.id}/wallet/transactions`, {
      type: 'DEPOSIT',
      amount: '5000.00',
      method: 'CASH',
      externalReference: 'SLIP-1',
    });
    assert.equal(entry.status, 201, JSON.stringify(entry.body));
    assert.equal(entry.data.summary.balance, 500000);
    assert.equal(entry.data.summary.total_deposited, 500000);

    const set = await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });
    assert.equal(set.status, 200);
    const portal = await loginReady(investor.mobile, TEMP_PASSWORD);

    const request = await portal.post('/api/portal/wallet/requests', {
      type: 'WITHDRAWAL',
      amount: '1200.00',
      method: 'BKASH',
      reference: '01711112222',
      note: 'Monthly payout',
    });
    assert.equal(request.status, 201, JSON.stringify(request.body));
    assert.equal(request.data.transaction.status, 'PENDING');
    assert.equal(request.data.summary.available_balance, 500000 - 120000);

    const wallet = await portal.get('/api/portal/wallet');
    assert.equal(wallet.status, 200);
    assert.equal(wallet.data.summary.pending_withdrawals, 120000);
    assert.ok(wallet.data.transactions.some((tx) => tx.status === 'PENDING'));

    const approved = await accountant.post(
      `/api/investors/${investor.id}/wallet/transactions/${request.data.transaction.id}/decide`,
      { decision: 'APPROVE', note: 'Paid via bKash' },
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.data.transaction.status, 'COMPLETED');
    assert.equal(approved.data.summary.balance, 500000 - 120000);

    const overdraw = await portal.post('/api/portal/wallet/requests', { type: 'WITHDRAWAL', amount: '999999.00', method: 'BKASH' });
    assert.equal(overdraw.status, 400);
  });

  test('freezing blocks wallet moves and revokes the portal session until unfrozen', async () => {
    const { investor, portal } = await makePortalInvestor();
    const freeze = await superAdmin.post(`/api/investors/${investor.id}/freeze`, { frozen: true, reason: 'Compliance review' });
    assert.equal(freeze.status, 200);
    assert.ok(freeze.data.investor.frozen_at);

    const blocked = await portal.post('/api/portal/wallet/requests', { type: 'DEPOSIT', amount: '100.00', method: 'BKASH' });
    assert.equal(blocked.status, 401, 'freeze must revoke the live portal session');

    const relogin = await loginReady(investor.mobile, FINAL_PASSWORD);
    const stillBlocked = await relogin.post('/api/portal/wallet/requests', { type: 'DEPOSIT', amount: '100.00', method: 'BKASH' });
    assert.equal(stillBlocked.status, 400);
    assert.match(stillBlocked.error.message, /frozen/i);

    const unfreeze = await superAdmin.post(`/api/investors/${investor.id}/freeze`, { frozen: false });
    assert.equal(unfreeze.status, 200);
    assert.equal(unfreeze.data.investor.frozen_at, null);
  });

  test('only staff can post a manual ledger entry', async () => {
    const { investor, portal } = await makePortalInvestor();
    const denied = await portal.post(`/api/investors/${investor.id}/wallet/transactions`, {
      type: 'DEPOSIT',
      amount: '50.00',
      method: 'CASH',
    });
    // A portal session is not an admin session at all.
    assert.ok([401, 403, 404].includes(denied.status), `unexpected status ${denied.status}`);
  });
});

describe('documents', () => {
  test('portal uploads land as PENDING and the owner can read them back', async () => {
    const { investor, portal } = await makePortalInvestor();
    const upload = await portal.upload('/api/portal/documents/PHOTO', PIXEL_PNG, 'image/png');
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    assert.equal(upload.data.document.kind, 'PHOTO');
    assert.equal(upload.data.document.status, 'PENDING');
    const slot = upload.data.documents.slots.find((row) => row.kind === 'PHOTO');
    assert.equal(slot.has_file, true);
    assert.equal(slot.status, 'PENDING');

    const file = await portal.get('/api/portal/documents/PHOTO/file');
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');

    const adminDocuments = await superAdmin.get(`/api/investors/${investor.id}/documents`);
    assert.equal(adminDocuments.status, 200);
    assert.equal(adminDocuments.data.slots.find((row) => row.kind === 'PHOTO').status, 'PENDING');
  });

  test('NID and signature slots are Super-Admin-only and rejection needs a note', async () => {
    const { investor } = await createInvestorWithInvestment(superAdmin, { mobile: nextMobile(), createInvestment: false });

    const accountantUpload = await accountant.upload(`/api/investors/${investor.id}/documents/NID_FRONT`, PIXEL_PNG, 'image/png');
    assert.equal(accountantUpload.status, 403);

    const upload = await superAdmin.upload(`/api/investors/${investor.id}/documents/NID_FRONT`, PIXEL_PNG, 'image/png');
    assert.equal(upload.status, 200, JSON.stringify(upload.body));

    const noNote = await superAdmin.post(`/api/investors/${investor.id}/documents/NID_FRONT/review`, { status: 'REJECTED' });
    assert.equal(noNote.status, 400);

    const rejected = await superAdmin.post(`/api/investors/${investor.id}/documents/NID_FRONT/review`, {
      status: 'REJECTED',
      note: 'Blurry photo',
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.document.status, 'REJECTED');
    assert.equal(rejected.data.documents.slots.find((row) => row.kind === 'NID_FRONT').review_note, 'Blurry photo');

    const verified = await superAdmin.post(`/api/investors/${investor.id}/documents/NID_FRONT/review`, { status: 'VERIFIED' });
    assert.equal(verified.status, 200);
    assert.equal(verified.data.document.status, 'VERIFIED');
  });

  test('nominee photos are stored per nominee', async () => {
    const { investor } = await createInvestorWithInvestment(superAdmin, {
      mobile: nextMobile(),
      createInvestment: false,
      nominees: [{ name: 'Nominee One', relation: 'Spouse', mobile: nextMobile(), share_percent: 100 }],
    });
    const detail = await superAdmin.get(`/api/investors/${investor.id}`);
    const nominee = detail.data.nominees[0];

    const upload = await superAdmin.upload(`/api/investors/${investor.id}/nominees/${nominee.id}/photo`, PIXEL_PNG, 'image/png');
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    assert.equal(upload.data.document.nominee_id, nominee.id);

    const documents = await superAdmin.get(`/api/investors/${investor.id}/documents`);
    assert.equal(documents.data.nominee_photos.length, 1);
    assert.equal(documents.data.nominee_photos[0].nominee_id, nominee.id);
  });
});

describe('nominee updates', () => {
  test('saving an existing nominee keeps its NID and uploaded photo', async () => {
    const { investor } = await createInvestorWithInvestment(superAdmin, {
      mobile: nextMobile(),
      createInvestment: false,
      nominees: [{ name: 'Original Nominee', relation: 'Spouse', mobile: nextMobile(), nid: nextNid(), share_percent: 100 }],
    });
    const before = (await superAdmin.get(`/api/investors/${investor.id}`)).data.nominees[0];
    assert.ok(before.nid_last4, 'nominee NID should be stored');

    const photo = await superAdmin.upload(`/api/investors/${investor.id}/nominees/${before.id}/photo`, PIXEL_PNG, 'image/png');
    assert.equal(photo.status, 200, JSON.stringify(photo.body));

    const saved = await superAdmin.post(`/api/investors/${investor.id}/nominees`, {
      nominees: [
        {
          id: before.id,
          name: 'Updated Nominee',
          relation: 'Spouse',
          mobile: before.mobile,
          share_percent: 100,
        },
      ],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.data.nominees.length, 1);
    assert.equal(saved.data.nominees[0].id, before.id, 'the nominee row must be updated, not recreated');
    assert.equal(saved.data.nominees[0].name, 'Updated Nominee');
    assert.equal(saved.data.nominees[0].nid_last4, before.nid_last4, 'NID must survive a save without re-typing it');

    const documents = await superAdmin.get(`/api/investors/${investor.id}/documents`);
    assert.equal(documents.data.nominee_photos.length, 1, 'the nominee photo must survive a save');
    assert.equal(documents.data.nominee_photos[0].nominee_id, before.id);
  });

  test('removing a nominee still enforces the 100% rule', async () => {
    const { investor } = await createInvestorWithInvestment(superAdmin, {
      mobile: nextMobile(),
      createInvestment: false,
      nominees: [
        { name: 'First Nominee', relation: 'Spouse', mobile: nextMobile(), share_percent: 60 },
        { name: 'Second Nominee', relation: 'Child', mobile: nextMobile(), share_percent: 40 },
      ],
    });
    const detail = await superAdmin.get(`/api/investors/${investor.id}`);
    const [first] = detail.data.nominees;
    const bad = await superAdmin.post(`/api/investors/${investor.id}/nominees`, {
      nominees: [{ id: first.id, name: first.name, relation: first.relation, mobile: first.mobile, share_percent: 60 }],
    });
    assert.equal(bad.status, 400);
    assert.match(bad.error.message, /100%/);
  });
});

describe('support tickets', () => {
  test('portal creates, staff replies, investor reopens and closes', async () => {
    const { investor, portal } = await makePortalInvestor();

    const created = await portal.post('/api/portal/support/tickets', {
      subject: 'Wallet withdrawal delayed',
      category: 'WALLET',
      priority: 'HIGH',
      message: 'My withdrawal has not arrived.',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.data.ticket.ticket_no, /^TKT-\d{6}$/);
    assert.equal(created.data.ticket.status, 'OPEN');
    const ticketId = created.data.ticket.id;

    const inbox = await superAdmin.get('/api/support/tickets?status=OPEN');
    assert.equal(inbox.status, 200);
    assert.ok(inbox.data.items.some((row) => row.id === ticketId && row.investor_name === investor.name));

    const reply = await accountant.post(`/api/support/tickets/${ticketId}/messages`, {
      message: 'We are checking with the bank.',
      status: 'IN_PROGRESS',
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.data.ticket.status, 'IN_PROGRESS');
    assert.equal(reply.data.ticket.last_message_by, 'ADMIN');

    const resolved = await superAdmin.post(`/api/support/tickets/${ticketId}/status`, { status: 'RESOLVED' });
    assert.equal(resolved.status, 200);

    const reopen = await portal.post(`/api/portal/support/tickets/${ticketId}/messages`, { message: 'Still waiting.' });
    assert.equal(reopen.status, 200);
    assert.equal(reopen.data.ticket.status, 'OPEN');

    const closed = await portal.post(`/api/portal/support/tickets/${ticketId}/close`);
    assert.equal(closed.status, 200);
    assert.equal(closed.data.ticket.status, 'CLOSED');

    const afterClose = await portal.post(`/api/portal/support/tickets/${ticketId}/messages`, { message: 'Hello?' });
    assert.equal(afterClose.status, 400);

    const adminAfterClose = await superAdmin.post(`/api/support/tickets/${ticketId}/messages`, { message: 'Reopen first' });
    assert.equal(adminAfterClose.status, 400);
  });

  test('investors cannot read another investor’s ticket', async () => {
    const first = await makePortalInvestor();
    const second = await makePortalInvestor();
    const created = await first.portal.post('/api/portal/support/tickets', {
      subject: 'Private inquiry',
      category: 'GENERAL',
      message: 'Only for the office.',
    });
    assert.equal(created.status, 201);
    const peek = await second.portal.get(`/api/portal/support/tickets/${created.data.ticket.id}`);
    assert.equal(peek.status, 404);
  });
});

describe('profile + printable documents', () => {
  test('portal updates self-service fields but cannot change the legal name', async () => {
    const { portal } = await makePortalInvestor();
    const patch = await portal.patch('/api/portal/profile', {
      present_address: 'Flat 3B, Dhanmondi, Dhaka',
      permanent_address: 'Shibganj, Chapainawabganj',
      religion: 'Islam',
      education: 'BSS',
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    assert.equal(patch.data.profile.present_address, 'Flat 3B, Dhanmondi, Dhaka');

    const nameChange = await portal.patch('/api/portal/profile', { name: 'Hacked Name' });
    assert.equal(nameChange.status, 400);
  });

  test('statement and membership certificate are print-ready HTML', async () => {
    const { portal } = await makePortalInvestor();
    const statement = await portal.get('/api/portal/statement.html');
    assert.equal(statement.status, 200);
    assert.match(statement.headers.get('content-type'), /text\/html/);
    assert.match(statement.text, /<html/i);

    const certificate = await portal.get('/api/portal/certificate');
    assert.equal(certificate.status, 200);
    assert.match(certificate.headers.get('content-type'), /text\/html/);
    assert.match(certificate.text, /certificate/i);
  });
});
