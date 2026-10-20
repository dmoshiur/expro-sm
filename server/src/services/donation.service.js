/**
 * Donates: investor contributions to welfare funds, paid through the same
 * gateway adapter as installments and receipted digitally.
 *
 * Trust rules mirror payment.service.js:
 *   * the browser is never believed - the callback re-executes the payment with
 *     the gateway, and the status query parameters are ignored
 *   * amount and invoice number must match our record before anything is marked
 *     SUCCESS, and a gateway transaction id can be credited only once
 *   * a donation becomes SUCCESS only inside a DB transaction that writes the
 *     trx id and the audit row together
 *
 * Donations are a separate ledger: they never touch installments, investment
 * totals or the wallet.
 *
 * One deliberate difference: a transient gateway error during the callback
 * leaves the donation PENDING (the money may already have moved), so the verify
 * endpoint or the reconciliation job can settle it later. Installments mark
 * the attempt FAILED in that case.
 */
import { query, withTransaction } from '../db/client.js';
import { NOW } from '../db/sql.js';
import { config } from '../config/index.js';
import { badRequest, forbidden, notFound, serviceUnavailable, unprocessable } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { toPoisha, formatBDT } from '../utils/money.js';
import { memberCodeForId } from './investor-auth.service.js';
import { getGateway } from './gateways/index.js';
import * as audit from './audit.service.js';

/** Fund catalogue. Codes are stored on donation rows; names are shown to investors. */
export const DONATION_FUNDS = [
  {
    code: 'WELFARE',
    name: 'General welfare fund',
    description: 'Emergency support for members and their families facing hardship.',
  },
  {
    code: 'EDUCATION',
    name: 'Education support',
    description: 'School and college costs for the children of members.',
  },
  {
    code: 'MEDICAL',
    name: 'Medical assistance',
    description: 'Treatment costs for members and their dependants.',
  },
  {
    code: 'COMMUNITY',
    name: 'Community project',
    description: 'Local infrastructure and community projects run with members.',
  },
];

export const DONATION_PRESETS_TAKA = [100, 500, 1000, 2000, 5000];
export const DONATION_MIN_TAKA = 10;
/** Sanity ceiling per donation (5 lakh BDT). Not a business limit. */
export const DONATION_MAX_TAKA = 5_00_000;
export const DONATION_STATUSES = ['INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED'];
const TERMINAL = ['SUCCESS', 'FAILED', 'CANCELLED'];
const REUSE_WINDOW_MS = 60_000;

export function fundByCode(code) {
  return DONATION_FUNDS.find((fund) => fund.code === code) ?? null;
}

/** DON-<year>-<id padded>. Stable for the life of the row; also the gateway invoice number. */
export function donationReceiptNumber(row) {
  const stamp = new Date(row.created_at ?? Date.now());
  const year = new Date(stamp.getTime() + 6 * 3600_000).getUTCFullYear();
  return `DON-${year}-${String(row.id).padStart(6, '0')}`;
}

export function donationCallbackUrl() {
  return `${config.publicBaseUrl}/pay/callback?kind=donation`;
}

/** Validates a taka amount typed or chosen in the UI and returns integer poisha. */
export function parseDonationAmount(value) {
  const poisha = toPoisha(value);
  const taka = poisha / 100;
  if (!Number.isSafeInteger(poisha) || poisha <= 0) {
    throw unprocessable('Enter a valid amount', { amount: 'Enter a valid amount' });
  }
  if (taka < DONATION_MIN_TAKA) {
    throw unprocessable(`The minimum donation is ${formatBDT(DONATION_MIN_TAKA * 100)}`, {
      amount: `The minimum donation is ${formatBDT(DONATION_MIN_TAKA * 100)}`,
    });
  }
  if (taka > DONATION_MAX_TAKA) {
    throw unprocessable(`The maximum donation is ${formatBDT(DONATION_MAX_TAKA * 100)}`, {
      amount: `The maximum donation is ${formatBDT(DONATION_MAX_TAKA * 100)}`,
    });
  }
  return poisha;
}

/** Investor-facing DTO. Never includes raw gateway payloads or payer details. */
export function presentDonation(row) {
  const fund = fundByCode(row.fund_code);
  return {
    id: row.id,
    receipt_number: donationReceiptNumber(row),
    fund_code: row.fund_code,
    fund_name: fund?.name ?? row.fund_code,
    amount: Number(row.amount),
    status: row.status,
    trx_id: row.trx_id ?? null,
    gateway_status: row.gateway_status ?? null,
    failure_reason: row.failure_reason ?? null,
    paid_at: row.paid_at ?? null,
    created_at: row.created_at,
    is_settled: TERMINAL.includes(row.status),
  };
}

async function assertCanDonate(investorId) {
  const res = await query('select status, frozen_at, membership_status, deleted_at from investors where id = ?1', [investorId]);
  const account = res.rows[0];
  if (!account || account.deleted_at || account.status !== 'ACTIVE') {
    throw forbidden('This member account cannot make a donation. Please contact the office.');
  }
  if (account.frozen_at) throw forbidden('This account is frozen. Please contact the office.');
  if (account.membership_status === 'REJECTED') {
    throw forbidden('Membership verification is incomplete. Please contact the office.');
  }
}

async function getDonationRow(id, client = undefined) {
  const res = await query('select * from donations where id = ?1', [id], client);
  if (!res.rows[0]) throw notFound('Donation not found');
  return res.rows[0];
}

async function getOwnDonationRow(investorId, id) {
  const res = await query('select * from donations where id = ?1 and investor_id = ?2', [id, investorId]);
  if (!res.rows[0]) throw notFound('Donation not found');
  return res.rows[0];
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
/** POST /api/portal/donations - returns the gateway redirect for the investor. */
export async function createDonation({ investorId, fundCode, amountTaka }, req) {
  const fund = fundByCode(String(fundCode ?? ''));
  if (!fund) throw unprocessable('Choose a fund to donate to', { fund: 'Choose a fund to donate to' });
  const amount = parseDonationAmount(amountTaka);
  await assertCanDonate(investorId);

  // Double-click protection: reuse a very recent, still-open attempt.
  const cutoff = new Date(Date.now() - REUSE_WINDOW_MS).toISOString();
  const recent = await query(
    `select * from donations
      where investor_id = ?1 and fund_code = ?2 and amount = ?3 and status in ('INITIATED','PENDING') and created_at > ?4
      order by id desc limit 1`,
    [investorId, fund.code, amount, cutoff],
  );
  if (recent.rows[0]?.raw_response?.bkashURL) {
    return {
      donation: presentDonation(recent.rows[0]),
      paymentId: recent.rows[0].gateway_payment_id,
      redirectUrl: recent.rows[0].raw_response.bkashURL,
      reused: true,
    };
  }

  const inserted = await query(
    `insert into donations (investor_id, fund_code, amount, status, gateway)
     values (?1, ?2, ?3, 'INITIATED', 'BKASH') returning *`,
    [investorId, fund.code, amount],
  );
  const row = inserted.rows[0];
  const invoiceNumber = donationReceiptNumber(row);

  let created;
  try {
    created = await getGateway().createPayment({
      amountPoisha: amount,
      invoiceNumber,
      callbackUrl: donationCallbackUrl(),
      payerReference: `DON${investorId}`,
    });
  } catch (err) {
    logger.error('donation gateway create failed', { err, donationId: row.id });
    await query(
      `update donations set status = 'FAILED', failure_reason = ?2, updated_at = ${NOW} where id = ?1`,
      [row.id, 'The payment provider did not start the payment'],
    );
    await audit.record({
      action: audit.AUDIT_ACTIONS.DONATION_FAILED,
      entity: 'donation',
      entityId: row.id,
      newValue: { status: 'FAILED', reason: 'gateway_create_failed' },
      meta: { investorId },
      req,
    });
    throw serviceUnavailable('The payment provider is unavailable right now. Please try again shortly.');
  }

  const updated = await query(
    `update donations
        set gateway_payment_id = ?2, invoice_number = ?3, status = 'PENDING', gateway_status = ?4,
            raw_response = ?5, updated_at = ${NOW}
      where id = ?1
      returning *`,
    [row.id, created.paymentId, invoiceNumber, created.status ?? 'Initiated', JSON.stringify(created.raw ?? {})],
  );

  await audit.record({
    action: audit.AUDIT_ACTIONS.DONATION_INITIATED,
    entity: 'donation',
    entityId: row.id,
    newValue: {
      fund_code: fund.code,
      amount,
      invoice_number: invoiceNumber,
      gateway_payment_id: created.paymentId,
    },
    meta: { investorId, self: true },
    req,
  });

  return {
    donation: presentDonation(updated.rows[0]),
    paymentId: created.paymentId,
    redirectUrl: created.redirectUrl,
    reused: false,
  };
}

// ---------------------------------------------------------------------------
// Callback / verification
// ---------------------------------------------------------------------------
/** Gateway redirect target. The payment id is the only input we trust. */
export async function handleDonationCallback({ paymentId, req }) {
  if (!paymentId) throw badRequest('Missing payment id');
  const res = await query('select * from donations where gateway_payment_id = ?1', [paymentId]);
  const row = res.rows[0];
  if (!row) throw notFound('Unknown donation payment');

  if (row.status === 'SUCCESS') return { state: 'success', alreadySettled: true, donation: presentDonation(row) };
  if (['FAILED', 'CANCELLED'].includes(row.status)) {
    return { state: row.status.toLowerCase(), alreadySettled: true, donation: presentDonation(row) };
  }

  let result;
  try {
    result = await getGateway().executePayment({ paymentId });
  } catch (err) {
    // Keep the donation PENDING: the verify endpoint or reconciliation settles it.
    logger.error('donation gateway execute failed', { err, donationId: row.id });
    return { state: 'pending', error: true, donation: presentDonation(row) };
  }
  return settleDonation({ donation: row, result, source: 'CALLBACK', req });
}

/**
 * Shared settlement path for callbacks, the investor's verify call and the
 * reconciliation job. Idempotent: a settled donation returns its stored state.
 */
export async function settleDonation({ donation, result, source = 'RECONCILE', req = null }) {
  const normalized = result?.normalized ?? 'UNKNOWN';

  if (normalized === 'FAILED' || normalized === 'CANCELLED') {
    const updated = await markDonationTerminal(donation.id, normalized, { result, source, req });
    return { state: normalized.toLowerCase(), donation: presentDonation(updated) };
  }
  if (normalized === 'PENDING' || normalized === 'UNKNOWN') {
    const updated = await query(
      `update donations
          set status = case when status = 'INITIATED' then 'PENDING' else status end,
              gateway_status = coalesce(?2, gateway_status), raw_response = ?3,
              check_count = check_count + 1, updated_at = ${NOW}
        where id = ?1
        returning *`,
      [donation.id, result?.rawStatus ?? null, JSON.stringify(result?.raw ?? {})],
    );
    return { state: 'pending', donation: presentDonation(updated.rows[0] ?? donation) };
  }

  // ---- SUCCESS path: every business fact must match our record ------------
  const expectedAmount = Number(donation.amount);
  const reportedAmount = result.amount === null || result.amount === undefined ? null : Number(result.amount);
  if (reportedAmount !== null && reportedAmount !== expectedAmount) {
    logger.error('donation amount mismatch', { donationId: donation.id, expectedAmount, reportedAmount });
    const updated = await markDonationTerminal(donation.id, 'FAILED', {
      result,
      source,
      req,
      reason: `Amount mismatch: gateway reported ${reportedAmount} poisha, expected ${expectedAmount}`,
    });
    return { state: 'failed', reason: 'AMOUNT_MISMATCH', donation: presentDonation(updated) };
  }
  if (result.invoiceNumber && donation.invoice_number && String(result.invoiceNumber) !== String(donation.invoice_number)) {
    logger.error('donation invoice mismatch', { donationId: donation.id });
    const updated = await markDonationTerminal(donation.id, 'FAILED', {
      result,
      source,
      req,
      reason: `Invoice mismatch: gateway reported ${result.invoiceNumber}`,
    });
    return { state: 'failed', reason: 'INVOICE_MISMATCH', donation: presentDonation(updated) };
  }
  if (!result.trxId) {
    logger.error('gateway reported donation success without a trxId', { donationId: donation.id });
    return { state: 'pending', donation: presentDonation(donation) };
  }

  // A trx id already credited to an installment payment or another donation is a replay.
  const dupe = await query(
    `select id from payments where gateway = 'BKASH' and trx_id = ?1
     union all
     select id from donations where gateway = 'BKASH' and trx_id = ?1 and id <> ?2
     limit 1`,
    [result.trxId, donation.id],
  );
  if (dupe.rows[0]) {
    const updated = await markDonationTerminal(donation.id, 'FAILED', {
      result,
      source,
      req,
      reason: `Duplicate trxId ${result.trxId}`,
    });
    return { state: 'failed', reason: 'DUPLICATE_TRX', donation: presentDonation(updated) };
  }

  let settled;
  try {
    settled = await withTransaction(async (client) => {
      const locked = await client.query('select * from donations where id = ?1', [donation.id]);
      const current = locked.rows[0];
      if (!current) throw notFound('Donation not found');
      if (current.status === 'SUCCESS') return { row: current, alreadySettled: true };
      if (['FAILED', 'CANCELLED'].includes(current.status) && source !== 'RECONCILE') {
        // Never resurrect a terminal donation from a callback.
        return { row: current, alreadySettled: true };
      }

      const updated = await client.query(
        `update donations
            set status = 'SUCCESS', trx_id = ?2, gateway_status = ?3, raw_response = ?4, paid_at = ${NOW},
                check_count = check_count + 1, failure_reason = null, updated_at = ${NOW}
          where id = ?1
          returning *`,
        [current.id, result.trxId, result.rawStatus ?? 'Completed', JSON.stringify(result.raw ?? {})],
      );

      await audit.record(
        {
          action: audit.AUDIT_ACTIONS.DONATION_PAID,
          entity: 'donation',
          entityId: current.id,
          oldValue: { status: current.status },
          newValue: { status: 'SUCCESS', trx_id: result.trxId, amount: Number(current.amount), source },
          meta: { investorId: current.investor_id, fundCode: current.fund_code },
          req,
        },
        client,
      );
      return { row: updated.rows[0], alreadySettled: false };
    });
  } catch (err) {
    // Two settlements racing for the same trx id: the partial unique index wins.
    if (err?.code === 'UNIQUE_VIOLATION' && /trx_id/.test(String(err?.constraint ?? ''))) {
      const updated = await markDonationTerminal(donation.id, 'FAILED', {
        result,
        source,
        req,
        reason: `Duplicate trxId ${result.trxId}`,
      });
      return { state: 'failed', reason: 'DUPLICATE_TRX', donation: presentDonation(updated) };
    }
    throw err;
  }

  if (!settled.alreadySettled) {
    logger.info('donation settled', { donationId: settled.row.id, amount: Number(settled.row.amount), source });
  }
  return { state: 'success', alreadySettled: settled.alreadySettled, donation: presentDonation(settled.row) };
}

async function markDonationTerminal(id, status, { result, source, req, reason }) {
  const current = await getDonationRow(id);
  if (current.status === 'SUCCESS') return current; // never downgrade a settled donation
  const updated = await query(
    `update donations
        set status = ?2, gateway_status = ?3, raw_response = ?4, failure_reason = ?5,
            check_count = check_count + 1, updated_at = ${NOW}
      where id = ?1 and status <> 'SUCCESS'
      returning *`,
    [
      id,
      status,
      result?.rawStatus ?? null,
      JSON.stringify(result?.raw ?? {}),
      reason ? String(reason).slice(0, 500) : result?.statusMessage ? String(result.statusMessage).slice(0, 500) : null,
    ],
  );
  await audit.record({
    action: audit.AUDIT_ACTIONS.DONATION_FAILED,
    entity: 'donation',
    entityId: id,
    oldValue: { status: current.status },
    newValue: { status, source, reason: reason ?? result?.statusMessage ?? null },
    meta: { investorId: current.investor_id, fundCode: current.fund_code },
    req,
  });
  return updated.rows[0] ?? current;
}

/** POST /api/portal/donations/:id/verify - re-queries the gateway for an open donation. */
export async function verifyOwnDonation(investorId, donationId, req) {
  const row = await getOwnDonationRow(investorId, donationId);
  if (TERMINAL.includes(row.status)) return { state: row.status.toLowerCase(), donation: presentDonation(row) };
  if (!row.gateway_payment_id) return { state: 'pending', donation: presentDonation(row) };

  let result;
  try {
    result = await getGateway().queryPayment({ paymentId: row.gateway_payment_id });
  } catch (err) {
    logger.warn('donation verify failed', { err, donationId: row.id });
    return { state: 'pending', error: true, donation: presentDonation(row) };
  }
  return settleDonation({ donation: row, result, source: 'STATUS_QUERY', req });
}

/** Reconciliation: open donations older than the cutoff are re-queried with the gateway. */
export async function reconcileStuckDonations({ olderThanMinutes = config.payments.reconcileStuckAfterMinutes, limit = 25 } = {}) {
  const cutoff = new Date(Date.now() - Number(olderThanMinutes) * 60_000).toISOString();
  const res = await query(
    `select * from donations
      where status in ('INITIATED','PENDING') and gateway_payment_id is not null and created_at < ?1
      order by created_at asc limit ?2`,
    [cutoff, limit],
  );
  const outcomes = { checked: 0, settled: 0, failed: 0, pending: 0 };
  for (const row of res.rows) {
    outcomes.checked += 1;
    try {
      const result = await getGateway().queryPayment({ paymentId: row.gateway_payment_id });
      const settledState = await settleDonation({ donation: row, result, source: 'RECONCILE' });
      if (settledState.state === 'success') outcomes.settled += 1;
      else if (['failed', 'cancelled'].includes(settledState.state)) outcomes.failed += 1;
      else outcomes.pending += 1;
    } catch (err) {
      logger.warn('donation reconcile failed', { err, donationId: row.id });
      outcomes.pending += 1;
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function listOwnDonations(investorId, { limit = 50 } = {}) {
  const res = await query(
    'select * from donations where investor_id = ?1 order by created_at desc, id desc limit ?2',
    [investorId, Math.min(Number(limit) || 50, 200)],
  );
  return res.rows.map(presentDonation);
}

/** Everything the donate page needs in one request. */
export async function donationOverview(investorId) {
  const totals = await query(
    `select count(*) as count, coalesce(sum(case when status = 'SUCCESS' then amount else 0 end), 0) as total
       from donations where investor_id = ?1`,
    [investorId],
  );
  return {
    funds: DONATION_FUNDS,
    presets_taka: DONATION_PRESETS_TAKA,
    min_taka: DONATION_MIN_TAKA,
    max_taka: DONATION_MAX_TAKA,
    totals: { count: Number(totals.rows[0].count), total_donated: Number(totals.rows[0].total) },
    history: await listOwnDonations(investorId, { limit: 20 }),
  };
}

export async function getOwnDonation(investorId, donationId) {
  return presentDonation(await getOwnDonationRow(investorId, donationId));
}

/** Receipt source data. Only successful donations have a receipt. */
export async function getDonationReceiptData(investorId, donationId) {
  const row = await getOwnDonationRow(investorId, donationId);
  if (row.status !== 'SUCCESS') throw badRequest('Receipt is available after a successful donation');
  const investor = await query('select name, mobile from investors where id = ?1', [investorId]);
  return {
    ...presentDonation(row),
    trx_id: row.trx_id,
    investor: { name: investor.rows[0]?.name ?? '', member_code: memberCodeForId(investorId) },
    business: { name: config.totp.issuer, baseUrl: config.publicBaseUrl },
  };
}

/** Staff list (read-only). Mobile numbers are intentionally not included. */
export async function listDonations({ status = null, fundCode = null, search = null, limit = 25, offset = 0 } = {}) {
  const where = [];
  const params = [];
  const push = (value) => {
    params.push(value);
    return `?${params.length}`;
  };
  if (status) where.push(`d.status = ${push(status)}`);
  if (fundCode) where.push(`d.fund_code = ${push(fundCode)}`);
  if (search) {
    const term = `%${String(search).toLowerCase().trim()}%`;
    where.push(
      `(lower(i.name) like ${push(term)} or lower(coalesce(d.trx_id, '')) like ${push(term)} or cast(d.id as text) = ${push(String(search).trim())})`,
    );
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const pageLimit = Math.min(Number(limit) || 25, 200);
  const pageOffset = Math.max(Number(offset) || 0, 0);
  const rows = await query(
    `select d.*, i.id as investor_id, i.name as investor_name
       from donations d join investors i on i.id = d.investor_id
       ${whereSql}
      order by d.created_at desc, d.id desc
      limit ${push(pageLimit)} offset ${push(pageOffset)}`,
    params,
  );
  const totals = await query(
    `select count(*) as count, coalesce(sum(case when d.status = 'SUCCESS' then d.amount else 0 end), 0) as success_amount
       from donations d join investors i on i.id = d.investor_id
       ${whereSql}`,
    params.slice(0, params.length - 2),
  );
  return {
    rows: rows.rows.map((row) => ({
      ...presentDonation(row),
      investor: { id: row.investor_id, name: row.investor_name, member_code: memberCodeForId(row.investor_id) },
    })),
    total: Number(totals.rows[0].count),
    successAmount: Number(totals.rows[0].success_amount),
    limit: pageLimit,
    offset: pageOffset,
  };
}
