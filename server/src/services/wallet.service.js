/**
 * Investor wallet ledger.
 *
 * Accounting model (integer poisha, never floats):
 *   balance = sum(CREDIT amounts) - sum(DEBIT amounts)   [only status=COMPLETED]
 *
 *  * An investor can REQUEST a deposit (credit) or a withdrawal (debit); the
 *    row starts as PENDING and does not touch the balance.
 *  * An accountant / Super Admin approves (COMPLETED) or rejects (REJECTED).
 *  * Staff can also post a manual ledger entry (earning, adjustment, fee) which
 *    is written straight to COMPLETED. Every write is audited.
 *  * Pending withdrawals reduce the "available" balance shown to the investor,
 *    so two simultaneous requests can never overdraw the wallet.
 */
import { query, withTransaction } from '../db/client.js';
import { NOW } from '../db/sql.js';
import { badRequest, notFound } from '../utils/errors.js';
import { formatBDT } from '../utils/money.js';
import * as audit from './audit.service.js';

export const WALLET_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'EARNING', 'ADJUSTMENT', 'FEE'];
export const WALLET_REQUEST_TYPES = ['DEPOSIT', 'WITHDRAWAL'];
export const WALLET_METHODS = ['CASH', 'BKASH', 'BANK', 'OTHER'];
export const WALLET_STATUSES = ['PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED'];
const DIRECTIONS = { DEPOSIT: 'CREDIT', EARNING: 'CREDIT', WITHDRAWAL: 'DEBIT', FEE: 'DEBIT' };

/** 10 crore BDT - a sanity ceiling, not a business limit. */
export const WALLET_MAX_AMOUNT = 10_00_00_000 * 100;

export function walletStatusLabel(status) {
  return { PENDING: 'Pending', COMPLETED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' }[status] ?? status;
}

export function walletTypeLabel(type) {
  return (
    {
      DEPOSIT: 'Deposit',
      WITHDRAWAL: 'Withdrawal',
      EARNING: 'Earning / profit',
      ADJUSTMENT: 'Manual adjustment',
      FEE: 'Fee',
    }[type] ?? type
  );
}

function money(poisha) {
  return formatBDT(Number(poisha ?? 0));
}

async function loadInvestor(client, investorId) {
  const res = await query(
    `select id, name, member_code, status, deleted_at, frozen_at, frozen_reason
       from investors where id = ?1`,
    [investorId],
    client,
  );
  if (!res.rows[0]) throw notFound('Investor not found');
  return res.rows[0];
}

/** Current wallet snapshot. Safe to call for an empty wallet (all zeroes). */
export async function getWalletSummary(investorId, client = undefined) {
  const res = await query(
    `select
       coalesce(sum(case when status = 'COMPLETED' and direction = 'CREDIT' then amount else 0 end), 0)
         - coalesce(sum(case when status = 'COMPLETED' and direction = 'DEBIT' then amount else 0 end), 0) as balance,
       coalesce(sum(case when status = 'COMPLETED' and type = 'DEPOSIT' then amount else 0 end), 0) as total_deposited,
       coalesce(sum(case when status = 'COMPLETED' and type = 'WITHDRAWAL' then amount else 0 end), 0) as total_withdrawn,
       coalesce(sum(case when status = 'COMPLETED' and type = 'EARNING' then amount else 0 end), 0) as total_earned,
       coalesce(sum(case when status = 'COMPLETED' and type = 'FEE' then amount else 0 end), 0) as total_fees,
       coalesce(sum(case when status = 'PENDING' and type = 'DEPOSIT' then amount else 0 end), 0) as pending_deposits,
       coalesce(sum(case when status = 'PENDING' and type = 'WITHDRAWAL' then amount else 0 end), 0) as pending_withdrawals,
       coalesce(sum(case when status = 'PENDING' then 1 else 0 end), 0) as pending_requests,
       max(updated_at) as updated_at
     from wallet_transactions where investor_id = ?1`,
    [investorId],
    client,
  );
  const row = res.rows[0] ?? {};
  const balance = Number(row.balance ?? 0);
  const pendingWithdrawals = Number(row.pending_withdrawals ?? 0);
  return {
    balance,
    available_balance: balance - pendingWithdrawals,
    total_deposited: Number(row.total_deposited ?? 0),
    total_withdrawn: Number(row.total_withdrawn ?? 0),
    total_earned: Number(row.total_earned ?? 0),
    total_fees: Number(row.total_fees ?? 0),
    pending_deposits: Number(row.pending_deposits ?? 0),
    pending_withdrawals: pendingWithdrawals,
    pending_requests: Number(row.pending_requests ?? 0),
    updated_at: row.updated_at ?? null,
    currency: 'BDT',
  };
}

export async function listTransactions(investorId, { status = null, type = null, limit = 100 } = {}, client = undefined) {
  const params = [investorId];
  const where = ['investor_id = ?1'];
  if (status) {
    params.push(status);
    where.push(`status = ?${params.length}`);
  }
  if (type) {
    params.push(type);
    where.push(`type = ?${params.length}`);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  const res = await query(
    `select id, reference, type, direction, amount, status, method, external_reference, note,
            requested_at, reviewed_at, review_note, created_at, updated_at
       from wallet_transactions
      where ${where.join(' and ')}
      order by coalesce(reviewed_at, requested_at, created_at) desc, id desc
      limit ?${params.length}`,
    params,
    client,
  );
  return res.rows.map((row) => ({
    ...row,
    type_label: walletTypeLabel(row.type),
    status_label: walletStatusLabel(row.status),
    signed_amount: row.direction === 'CREDIT' ? Number(row.amount) : -Number(row.amount),
  }));
}

/** Wallet tab payload: summary + recent ledger rows. */
export async function getWallet(investorId, { limit = 100 } = {}) {
  const [summary, transactions] = await Promise.all([getWalletSummary(investorId), listTransactions(investorId, { limit })]);
  return { summary, transactions };
}

function validateRequest({ type, amount, method, externalReference, note }) {
  if (!WALLET_REQUEST_TYPES.includes(type)) throw badRequest('Wallet requests must be a deposit or a withdrawal');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest('Amount must be a positive whole number of poisha');
  if (amount > WALLET_MAX_AMOUNT) throw badRequest(`Amount cannot exceed ${money(WALLET_MAX_AMOUNT)}`);
  if (method && !WALLET_METHODS.includes(method)) throw badRequest('Invalid wallet method');
  if (type === 'DEPOSIT' && !method) throw badRequest('Choose how you will deposit the money');
  if (note && String(note).length > 500) throw badRequest('Note is too long');
  if (externalReference && String(externalReference).length > 120) throw badRequest('Reference is too long');
}

/**
 * Investor-initiated deposit / withdrawal request (PENDING until staff decide).
 * A frozen or closed account cannot move money.
 */
export async function requestTransaction(investorId, input, req) {
  return withTransaction(async (client) => {
    const investor = await loadInvestor(client, investorId);
    if (investor.deleted_at) throw badRequest('This account is not available');
    if (investor.status !== 'ACTIVE') throw badRequest('Only an active member can move wallet money');
    if (investor.frozen_at) throw badRequest('This account is frozen. Please contact the office.');
    if (investor.membership_status === 'REJECTED') {
      throw badRequest('Membership verification is incomplete. Please contact the office.');
    }

    validateRequest(input);
    const { type, amount, method = null, externalReference = null, note = null } = input;
    const direction = DIRECTIONS[type];

    if (type === 'WITHDRAWAL') {
      const summary = await getWalletSummary(investorId, client);
      if (amount > summary.available_balance) {
        throw badRequest(
          `Withdrawal exceeds the available balance (${money(summary.available_balance)} available, including pending withdrawals)`,
        );
      }
    }

    const inserted = await query(
      `insert into wallet_transactions (investor_id, reference, type, direction, amount, status, method,
                                        external_reference, note, requested_at)
       values (?1, ?2, ?3, ?4, ?5, 'PENDING', ?6, ?7, ?8, ${NOW}) returning id`,
      [investorId, `TMP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, type, direction, amount, method, externalReference, note],
      client,
    );
    const id = inserted.rows[0].id;
    const reference = `WLT-${String(id).padStart(6, '0')}`;
    await query('update wallet_transactions set reference = ?2 where id = ?1', [id, reference], client);

    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.WALLET_REQUESTED,
        entity: 'wallet_transaction',
        entityId: id,
        newValue: { reference, type, direction, amount, method },
        meta: { self: true, investorId },
        req,
      },
      client,
    );
    const row = await query('select * from wallet_transactions where id = ?1', [id], client);
    return {
      transaction: { ...row.rows[0], type_label: walletTypeLabel(type), status_label: walletStatusLabel('PENDING') },
      summary: await getWalletSummary(investorId, client),
    };
  });
}

/** Admin decision on a pending request: APPROVE -> COMPLETED, REJECT -> REJECTED. */
export async function decideTransaction(investorId, transactionId, { decision, note = null }, actor, req) {
  if (!['APPROVE', 'REJECT'].includes(decision)) throw badRequest('Decision must be APPROVE or REJECT');
  return withTransaction(async (client) => {
    const current = await query(
      'select * from wallet_transactions where id = ?1 and investor_id = ?2',
      [transactionId, investorId],
      client,
    );
    const before = current.rows[0];
    if (!before) throw notFound('Wallet transaction not found');
    if (before.status !== 'PENDING') throw badRequest(`This request is already ${walletStatusLabel(before.status).toLowerCase()}`);

    if (decision === 'APPROVE' && before.type === 'WITHDRAWAL') {
      // Re-check: another request may have been approved since this one was created.
      const summary = await getWalletSummary(investorId, client);
      if (Number(before.amount) > summary.balance) {
        throw badRequest(
          `Approving this withdrawal would overdraw the wallet (balance ${money(summary.balance)}). Reject it or record a deposit first.`,
        );
      }
    }

    const status = decision === 'APPROVE' ? 'COMPLETED' : 'REJECTED';
    const res = await query(
      `update wallet_transactions
          set status = ?2, reviewed_at = ${NOW}, reviewed_by = ?3, review_note = ?4
        where id = ?1 returning *`,
      [transactionId, status, actor?.id ?? null, note],
      client,
    );
    await audit.record(
      {
        action: decision === 'APPROVE' ? audit.AUDIT_ACTIONS.WALLET_APPROVED : audit.AUDIT_ACTIONS.WALLET_REJECTED,
        entity: 'wallet_transaction',
        entityId: transactionId,
        oldValue: { status: before.status, amount: before.amount, type: before.type },
        newValue: { status, note },
        meta: { investorId, reference: before.reference },
        actor,
        req,
      },
      client,
    );
    return {
      transaction: { ...res.rows[0], type_label: walletTypeLabel(before.type), status_label: walletStatusLabel(status) },
      summary: await getWalletSummary(investorId, client),
    };
  });
}

/**
 * Manual ledger entry by staff (cash deposit, profit credit, correction, fee).
 * Written to COMPLETED immediately and audited. Debits can never overdraw.
 */
export async function recordLedgerEntry(investorId, input, actor, req) {
  return withTransaction(async (client) => {
    const investor = await loadInvestor(client, investorId);
    if (investor.deleted_at) throw badRequest('Investor is deleted; restore it first');

    const type = input.type;
    if (!WALLET_TYPES.includes(type)) throw badRequest('Invalid ledger entry type');
    const amount = input.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest('Amount must be a positive whole number of poisha');
    if (amount > WALLET_MAX_AMOUNT) throw badRequest(`Amount cannot exceed ${money(WALLET_MAX_AMOUNT)}`);
    const direction = type === 'ADJUSTMENT' ? input.direction : DIRECTIONS[type];
    if (!['CREDIT', 'DEBIT'].includes(direction)) throw badRequest('Direction must be CREDIT or DEBIT');
    if (input.method && !WALLET_METHODS.includes(input.method)) throw badRequest('Invalid wallet method');

    if (direction === 'DEBIT') {
      const summary = await getWalletSummary(investorId, client);
      if (amount > summary.balance) throw badRequest(`A debit cannot exceed the current balance (${money(summary.balance)})`);
    }

    const inserted = await query(
      `insert into wallet_transactions (investor_id, reference, type, direction, amount, status, method,
                                        external_reference, note, requested_at, reviewed_at, reviewed_by, review_note, created_by)
       values (?1, ?2, ?3, ?4, ?5, 'COMPLETED', ?6, ?7, ?8, ${NOW}, ${NOW}, ?9, ?10, ?9) returning id`,
      [
        investorId,
        `TMP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        type,
        direction,
        amount,
        input.method ?? null,
        input.externalReference ?? null,
        input.note ?? null,
        actor?.id ?? null,
        'Manual ledger entry',
      ],
      client,
    );
    const id = inserted.rows[0].id;
    const reference = `WLT-${String(id).padStart(6, '0')}`;
    await query('update wallet_transactions set reference = ?2 where id = ?1', [id, reference], client);

    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.WALLET_ENTRY_RECORDED,
        entity: 'wallet_transaction',
        entityId: id,
        newValue: { reference, type, direction, amount, method: input.method ?? null },
        meta: { investorId },
        actor,
        req,
      },
      client,
    );
    const row = await query('select * from wallet_transactions where id = ?1', [id], client);
    return {
      transaction: { ...row.rows[0], type_label: walletTypeLabel(type), status_label: walletStatusLabel('COMPLETED') },
      summary: await getWalletSummary(investorId, client),
    };
  });
}

/** Admin queue across investors (used by the dashboard badge / support inbox). */
export async function listPendingRequests({ limit = 50 } = {}) {
  const res = await query(
    `select w.id, w.reference, w.type, w.direction, w.amount, w.status, w.method, w.external_reference, w.note,
            w.requested_at, i.id as investor_id, i.name as investor_name, i.member_code
       from wallet_transactions w
       join investors i on i.id = w.investor_id
      where w.status = 'PENDING' and i.deleted_at is null
      order by w.requested_at asc
      limit ?1`,
    [Math.min(Number(limit) || 50, 200)],
  );
  return res.rows.map((row) => ({ ...row, type_label: walletTypeLabel(row.type), status_label: walletStatusLabel(row.status) }));
}

export async function countPendingRequests() {
  const res = await query("select count(*) as count from wallet_transactions where status = 'PENDING'");
  return Number(res.rows[0]?.count ?? 0);
}
