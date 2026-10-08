/**
 * Payments: start -> gateway -> callback -> verify -> settle.
 *
 * Trust rules (non-negotiable):
 *   * the client is never believed: the status query parameters of a callback
 *     are ignored, the server always re-executes / re-queries the gateway
 *   * amount, invoice number and gateway status must all match our record
 *   * an installment becomes PAID only inside a DB transaction that also marks
 *     the payment SUCCESS
 *   * duplicate callbacks, duplicate trxIds and replays are all no-ops
 */
import { query, withTransaction } from '../db/pool.js';
import { config } from '../config/index.js';
import { AppError, badRequest, conflict, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { maskMobile } from '../utils/mask.js';
import { dhakaDate } from '../utils/dates.js';
import { formatInvoiceNumber, operationId } from '../utils/ids.js';
import { getGateway } from './gateways/index.js';
import * as audit from './audit.service.js';
import { applyPayment, deriveStatus, getInstallment, outstandingPoisha, revertPayment } from './installment.service.js';
import { publicView, resolveToken } from './paylink.service.js';
import { sendManualPaymentSms, sendPaymentSuccessSms } from './sms.service.js';

export const PAYMENT_STATUSES = ['INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED'];
export const MANUAL_METHODS = ['CASH', 'BANK', 'OTHER'];
const REUSE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Start a gateway payment (the ONLY investor-facing write)
// ---------------------------------------------------------------------------
export async function startPayment({ token, req, payerMobile = null }) {
  const installment = await resolveToken(token);
  const view = publicView(installment);
  if (!view.canPay) {
    throw conflict(`This installment is already ${String(view.status).toLowerCase()}`, { status: view.status });
  }
  const amount = outstandingPoisha(installment);
  if (amount <= 0) throw conflict('Nothing left to pay on this installment');

  const gateway = getGateway();

  // Double-click protection: reuse a very recent, still-open attempt.
  const recent = await query(
    `select * from payments
      where installment_id = $1 and gateway = 'BKASH' and status in ('INITIATED','PENDING')
        and created_at > now() - ($2 || ' milliseconds')::interval
      order by created_at desc limit 1`,
    [installment.id, String(REUSE_WINDOW_MS)],
  );
  if (recent.rows[0]?.raw_response?.bkashURL) {
    logger.info('reusing recent payment attempt', { paymentId: recent.rows[0].id, installmentId: installment.id });
    return {
      paymentId: recent.rows[0].gateway_payment_id,
      internalId: recent.rows[0].id,
      redirectUrl: recent.rows[0].raw_response.bkashURL,
      reused: true,
      amount,
    };
  }

  const invoiceNumber = formatInvoiceNumber(installment.id);
  const callbackUrl = `${config.publicBaseUrl}/pay/callback?link=${encodeURIComponent(token)}`;
  const opId = operationId();

  const created = await gateway.createPayment({
    amountPoisha: amount,
    invoiceNumber,
    callbackUrl,
    payerReference: `INV${installment.investor_id}`,
  });

  const inserted = await query(
    `insert into payments (installment_id, gateway, gateway_payment_id, invoice_number, amount, status, method,
                           gateway_status, operation_id, raw_response, initiated_at, payer_mobile)
     values ($1,'BKASH',$2,$3,$4,'INITIATED','BKASH',$5,$6,$7, now(), $8)
     returning *`,
    [
      installment.id,
      created.paymentId,
      invoiceNumber,
      amount,
      created.status ?? 'Initiated',
      opId,
      JSON.stringify(created.raw ?? {}),
      payerMobile ? String(payerMobile).slice(0, 20) : null,
    ],
  );

  await audit.record({
    action: audit.AUDIT_ACTIONS.PAYMENT_INITIATED,
    entity: 'payment',
    entityId: inserted.rows[0].id,
    newValue: {
      installment_id: installment.id,
      amount,
      invoice_number: invoiceNumber,
      gateway_payment_id: created.paymentId,
      gateway: gateway.name,
    },
    meta: { serial: installment.serial, investmentId: installment.investment_id, payer: payerMobile ? maskMobile(payerMobile) : null },
    req,
  });

  return {
    paymentId: created.paymentId,
    internalId: inserted.rows[0].id,
    redirectUrl: created.redirectUrl,
    reused: false,
    amount,
  };
}

// ---------------------------------------------------------------------------
// Callback / verification
// ---------------------------------------------------------------------------
/**
 * Handles the return from the gateway. `queryParams` is only used to find our
 * own identifiers (link token + paymentID); every business fact is re-checked
 * with the gateway itself.
 */
export async function handleCallback({ linkToken, paymentId, req }) {
  if (!paymentId) throw badRequest('Missing payment id');
  const gateway = getGateway();

  const paymentRes = await query('select * from payments where gateway_payment_id = $1', [paymentId]);
  const payment = paymentRes.rows[0];
  if (!payment) throw notFound('Unknown payment');

  const installment = await getInstallment(payment.installment_id);

  // The link token must be the one that started this payment (defence in depth).
  if (linkToken) {
    const tokenRow = await resolveToken(linkToken).catch(() => null);
    if (tokenRow && Number(tokenRow.id) !== Number(installment.id)) {
      logger.warn('callback link/payment mismatch', { paymentId, expected: tokenRow.id, actual: installment.id });
      throw badRequest('Payment does not belong to this link');
    }
  }

  if (payment.status === 'SUCCESS') {
    return { state: 'success', alreadySettled: true, payment, installment };
  }
  if (['FAILED', 'CANCELLED'].includes(payment.status)) {
    return { state: payment.status.toLowerCase(), alreadySettled: true, payment, installment };
  }

  // Execute (bKash) or simulate completion (mock). Idempotent at the gateway.
  let result;
  try {
    result = await gateway.executePayment({ paymentId });
  } catch (err) {
    logger.error('gateway execute failed', { err, paymentId });
    await markFailed(payment.id, { reason: 'Gateway execute failed', gatewayStatus: 'ERROR', req });
    return { state: 'pending', error: true, payment: { ...payment, status: 'PENDING' }, installment };
  }

  return settleFromGateway({ payment, installment, result, source: 'CALLBACK', req });
}

/**
 * Shared settlement path used by the callback, manual status queries and the
 * reconciliation job. Idempotent: a second call for a settled payment is a
 * no-op that returns the stored state.
 */
export async function settleFromGateway({ payment, installment, result, source = 'RECONCILE', req = null }) {
  const normalized = result?.normalized ?? 'UNKNOWN';

  if (normalized === 'FAILED' || normalized === 'CANCELLED') {
    await markTerminal(payment.id, normalized, { result, source, req });
    return { state: normalized.toLowerCase(), payment: await getPayment(payment.id), installment };
  }
  if (normalized === 'PENDING' || normalized === 'UNKNOWN') {
    await query(
      `update payments set status = case when status = 'INITIATED' then 'PENDING' else status end,
              gateway_status = coalesce($2, gateway_status), raw_response = $3, check_count = check_count + 1
        where id = $1`,
      [payment.id, result?.rawStatus ?? null, JSON.stringify(result?.raw ?? {})],
    );
    return { state: 'pending', payment: await getPayment(payment.id), installment };
  }

  // ---- SUCCESS path ------------------------------------------------------
  const expectedAmount = Number(payment.amount);
  const reportedAmount = result.amount === null || result.amount === undefined ? null : Number(result.amount);
  if (reportedAmount !== null && reportedAmount !== expectedAmount) {
    logger.error('payment amount mismatch', { paymentId: payment.id, expectedAmount, reportedAmount });
    await markTerminal(payment.id, 'FAILED', {
      result,
      source,
      req,
      reason: `Amount mismatch: gateway reported ${reportedAmount} poisha, expected ${expectedAmount}`,
    });
    return { state: 'failed', reason: 'AMOUNT_MISMATCH', payment: await getPayment(payment.id), installment };
  }
  if (result.invoiceNumber && payment.invoice_number && String(result.invoiceNumber) !== String(payment.invoice_number)) {
    logger.error('payment invoice mismatch', { paymentId: payment.id, expected: payment.invoice_number, got: result.invoiceNumber });
    await markTerminal(payment.id, 'FAILED', {
      result,
      source,
      req,
      reason: `Invoice mismatch: gateway reported ${result.invoiceNumber}`,
    });
    return { state: 'failed', reason: 'INVOICE_MISMATCH', payment: await getPayment(payment.id), installment };
  }
  if (!result.trxId) {
    logger.error('gateway reported success without a trxId', { paymentId: payment.id });
    return { state: 'pending', payment: await getPayment(payment.id), installment };
  }

  let settled;
  try {
    settled = await withTransaction(async (client) => {
      const locked = await client.query('select * from payments where id = $1 for update', [payment.id]);
      const current = locked.rows[0];
      if (!current) throw notFound('Payment not found');
      if (current.status === 'SUCCESS') return { payment: current, installment, alreadySettled: true };
      if (['FAILED', 'CANCELLED'].includes(current.status) && source !== 'RECONCILE') {
        // Never resurrect a terminal payment from a callback.
        return { payment: current, installment, alreadySettled: true };
      }

      // Duplicate trxId (replay of another transaction): refuse to credit.
      const dupe = await client.query(
        'select id, installment_id, status from payments where gateway = $1 and trx_id = $2 and id <> $3',
        [current.gateway, result.trxId, current.id],
      );
      if (dupe.rows[0]) {
        logger.error('duplicate trxId detected', { trxId: result.trxId, existingPayment: dupe.rows[0].id, paymentId: current.id });
        // Note: throwing rolls the transaction back, so the FAILED state is
        // written by the caller (outside the transaction) - see the catch below.
        throw new AppError(409, 'DUPLICATE_TRX', 'This transaction has already been recorded');
      }

      const updated = await client.query(
        `update payments
            set status = 'SUCCESS', trx_id = $2, gateway_status = $3, raw_response = $4, verified_at = now(),
                paid_at = now(), check_count = check_count + 1, failure_reason = null
          where id = $1
          returning *`,
        [current.id, result.trxId, result.rawStatus ?? 'Completed', JSON.stringify(result.raw ?? {})],
      );
      const paidInstallment = await applyPayment(client, current.installment_id, current.amount);

      // Any sibling attempt for the same installment is now moot.
      await client.query(
        `update payments set status = 'CANCELLED', failure_reason = 'Superseded by a successful payment'
          where installment_id = $1 and id <> $2 and status in ('INITIATED','PENDING')`,
        [current.installment_id, current.id],
      );

      await audit.record(
        {
          action: audit.AUDIT_ACTIONS.PAYMENT_VERIFIED,
          entity: 'payment',
          entityId: current.id,
          oldValue: { status: current.status },
          newValue: {
            status: 'SUCCESS',
            trx_id: result.trxId,
            amount: Number(current.amount),
            source,
          },
          meta: {
            installmentId: current.installment_id,
            installmentStatus: paidInstallment.status,
            investorId: installment.investor_id,
          },
          req,
        },
      );
      return { payment: updated.rows[0], installment: { ...installment, ...paidInstallment }, alreadySettled: false };
    });
  } catch (err) {
    // Duplicate detection happens inside the transaction (rolls back), or is
    // raised by the partial unique index when two settlements race. Either way
    // the attempt must end up FAILED and audited, which is done here so the
    // write is not rolled back with the transaction.
    const isDuplicate =
      err?.code === 'DUPLICATE_TRX' || (err?.code === '23505' && String(err?.constraint ?? '').includes('trx'));
    if (isDuplicate) {
      await markFailed(payment.id, {
        reason: `Duplicate trxId ${result.trxId}`,
        gatewayStatus: result.rawStatus ?? null,
        req,
      });
      return { state: 'failed', reason: 'DUPLICATE_TRX', payment: await getPayment(payment.id), installment };
    }
    throw err;
  }

  if (!settled.alreadySettled) {
    logger.info('payment settled', {
      paymentId: settled.payment.id,
      trxId: settled.payment.trx_id,
      amount: Number(settled.payment.amount),
      source,
    });
    // Best-effort confirmation SMS; a failure here must not roll back money.
    try {
      const full = await getInstallment(settled.payment.installment_id);
      await sendPaymentSuccessSms({ payment: settled.payment, installment: full, req });
    } catch (err) {
      logger.warn('payment success sms failed', { err, paymentId: settled.payment.id });
    }
  }

  return {
    state: 'success',
    alreadySettled: settled.alreadySettled,
    payment: settled.payment,
    installment: await getInstallment(settled.payment.installment_id),
  };
}

async function markFailed(paymentId, { reason, gatewayStatus, req }) {
  await query(
    `update payments set status = 'FAILED', failure_reason = $2, gateway_status = coalesce($3, gateway_status)
      where id = $1 and status in ('INITIATED','PENDING')`,
    [paymentId, String(reason).slice(0, 300), gatewayStatus ?? null],
  );
  await audit.record({
    action: audit.AUDIT_ACTIONS.PAYMENT_FAILED,
    entity: 'payment',
    entityId: paymentId,
    newValue: { status: 'FAILED', reason },
    req,
  });
}

async function markTerminal(paymentId, status, { result, source, req, reason }) {
  const payment = await getPayment(paymentId);
  if (payment.status === 'SUCCESS') return payment; // never downgrade a settled payment
  const updated = await query(
    `update payments
        set status = $2, gateway_status = $3, raw_response = $4, failure_reason = $5, verified_at = now(),
            check_count = check_count + 1
      where id = $1 and status not in ('SUCCESS')
      returning *`,
    [
      paymentId,
      status,
      result?.rawStatus ?? null,
      JSON.stringify(result?.raw ?? {}),
      reason ? String(reason).slice(0, 500) : result?.statusMessage ? String(result.statusMessage).slice(0, 500) : null,
    ],
  );
  await audit.record({
    action: status === 'CANCELLED' ? audit.AUDIT_ACTIONS.PAYMENT_CANCELLED : audit.AUDIT_ACTIONS.PAYMENT_FAILED,
    entity: 'payment',
    entityId: paymentId,
    oldValue: { status: payment.status },
    newValue: { status, source, reason: reason ?? result?.statusMessage ?? null },
    req,
  });
  return updated.rows[0];
}

/**
 * Authoritative re-check for one payment (used by the "check status" button and
 * by the reconciliation job).
 */
export async function refreshPaymentStatus(paymentId, { req = null, source = 'STATUS_QUERY' } = {}) {
  const payment = await getPayment(paymentId);
  if (['SUCCESS', 'REFUNDED'].includes(payment.status)) return { state: 'success', payment, unchanged: true };
  if (!payment.gateway_payment_id) return { state: payment.status.toLowerCase(), payment, unchanged: true };
  const gateway = getGateway();
  const result = await gateway.queryPayment({ paymentId: payment.gateway_payment_id });
  if (result.normalized === 'SUCCESS' && payment.status !== 'SUCCESS') {
    if (payment.status === 'FAILED' || payment.status === 'CANCELLED') {
      throw conflict('A failed/cancelled payment cannot be settled automatically. Record the payment manually.');
    }
    const installment = await getInstallment(payment.installment_id);
    return settleFromGateway({ payment, installment, result, source, req });
  }
  if (result.normalized === 'FAILED' || result.normalized === 'CANCELLED') {
    await markTerminal(payment.id, result.normalized, { result, source, req });
    return { state: result.normalized.toLowerCase(), payment: await getPayment(payment.id) };
  }
  await query(
    `update payments set gateway_status = coalesce($2, gateway_status), raw_response = $3, check_count = check_count + 1,
            status = case when status = 'INITIATED' then 'PENDING' else status end
      where id = $1`,
    [payment.id, result.rawStatus ?? null, JSON.stringify(result.raw ?? {})],
  );
  return { state: 'pending', payment: await getPayment(payment.id) };
}

/**
 * Cancel / void a payment (accountant action).
 *
 *  - INITIATED / PENDING / FAILED attempts are simply closed.
 *  - A SUCCESS *manual* payment (cash / bank / other) is voided and the
 *    installment's amount_paid is reversed - this is how a wrong entry is fixed.
 *  - A SUCCESS gateway payment cannot be undone here: the money really moved at
 *    bKash, so it must be refunded there and recorded as a manual adjustment.
 */
export async function cancelPayment(paymentId, { reason } = {}, actor, req) {
  return withTransaction(async (client) => {
    const locked = await client.query('select * from payments where id = $1 for update', [paymentId]);
    const payment = locked.rows[0];
    if (!payment) throw notFound('Payment not found');
    if (payment.status === 'CANCELLED') return { ...payment, reversed: false }; // idempotent
    if (payment.status === 'REFUNDED') throw conflict('A refunded payment cannot be cancelled');
    const isManual = payment.gateway === 'MANUAL';
    if (payment.status === 'SUCCESS' && !isManual) {
      throw conflict('A settled bKash payment cannot be voided here - refund it in bKash and record the reversal as a manual entry');
    }
    const note = String(reason ?? 'Cancelled by administrator').slice(0, 500);
    const updated = await client.query(
      `update payments set status = 'CANCELLED', failure_reason = $2, verified_at = now() where id = $1 returning *`,
      [paymentId, note],
    );
    let installment = null;
    if (payment.status === 'SUCCESS' && isManual) {
      installment = await revertPayment(client, payment.installment_id, payment.amount);
    }
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.PAYMENT_CANCELLED,
        entity: 'payment',
        entityId: paymentId,
        oldValue: { status: payment.status, amount: Number(payment.amount) },
        newValue: {
          status: 'CANCELLED',
          reason: note,
          reversed: Boolean(installment),
          installment_status: installment?.status ?? null,
        },
        meta: { gateway: payment.gateway, installmentId: payment.installment_id },
        actor,
        req,
      },
      client,
    );
    return { ...updated.rows[0], reversed: Boolean(installment), installment: installment ?? undefined };
  });
}

// ---------------------------------------------------------------------------
// Manual payments (cash / bank), recorded by an accountant
// ---------------------------------------------------------------------------
export async function recordManualPayment(
  { installmentId, amount, method, reference, note, paidAt = null, notify = false },
  actor,
  req,
) {
  if (!MANUAL_METHODS.includes(method)) throw badRequest(`Method must be one of: ${MANUAL_METHODS.join(', ')}`);
  if (!reference || String(reference).trim().length < 3) {
    throw badRequest('A payment reference (receipt/slip/deposit number) is required');
  }

  const result = await withTransaction(async (client) => {
    const locked = await client.query(
      `select inst.*, v.investor_id, i.name as investor_name, i.mobile as investor_mobile
         from installments inst
         join investments v on v.id = inst.investment_id
         join investors i on i.id = v.investor_id
        where inst.id = $1 for update`,
      [installmentId],
    );
    const installment = locked.rows[0];
    if (!installment) throw notFound('Installment not found');
    if (['CANCELLED', 'WAIVED'].includes(installment.status)) {
      throw conflict(`Cannot record a payment for a ${installment.status.toLowerCase()} installment`);
    }
    const outstanding = outstandingPoisha(installment);
    if (outstanding <= 0) throw conflict('This installment is already fully paid');
    if (Number(amount) > outstanding) {
      throw badRequest(`Amount exceeds the outstanding balance of ${outstanding} poisha`, { outstanding });
    }

    // Guard against double entry of the same reference.
    const dupe = await client.query(
      `select id from payments where installment_id = $1 and method = $2 and manual_reference = $3 and amount = $4 and status = 'SUCCESS'`,
      [installmentId, method, String(reference).trim(), Number(amount)],
    );
    if (dupe.rows[0]) throw conflict('An identical payment is already recorded for this installment', { paymentId: dupe.rows[0].id });

    const inserted = await client.query(
      `insert into payments (installment_id, gateway, trx_id, invoice_number, amount, status, method, manual_reference,
                             reference_note, recorded_by_admin_id, gateway_status, raw_response, paid_at, verified_at)
       values ($1,'MANUAL',$2,$3,$4,'SUCCESS',$5,$6,$7,$8,'MANUAL',$9, coalesce($10, now()), now())
       returning *`,
      [
        installmentId,
        method === 'BANK' ? String(reference).trim() : null,
        formatInvoiceNumber(installment.id),
        Number(amount),
        method,
        String(reference).trim(),
        note ? String(note).slice(0, 500) : null,
        actor?.id ?? null,
        JSON.stringify({ manual: true, recordedBy: actor?.email ?? null, method, reference: String(reference).trim() }),
        paidAt,
      ],
    );
    const payment = inserted.rows[0];
    const updatedInstallment = await applyPayment(client, installmentId, Number(amount));

    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.PAYMENT_MANUAL_RECORDED,
        entity: 'payment',
        entityId: payment.id,
        newValue: {
          installment_id: installmentId,
          amount: Number(amount),
          method,
          manual_reference: String(reference).trim(),
          note: note ?? null,
          installment_status: updatedInstallment.status,
        },
        meta: { investorId: installment.investor_id, serial: installment.serial },
        actor,
        req,
      },
    );
    return { payment, installment: { ...installment, ...updatedInstallment } };
  });

  if (notify) {
    try {
      await sendManualPaymentSms({ payment: result.payment, installment: result.installment, req, actor });
    } catch (err) {
      logger.warn('manual payment sms failed', { err, paymentId: result.payment.id });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const PAYMENT_SELECT = `
  select p.*, inst.serial as installment_serial, inst.due_date, inst.status as installment_status,
         inst.amount as installment_amount, inst.amount_paid as installment_amount_paid,
         v.id as investment_id, v.total_amount as investment_total,
         i.id as investor_id, i.name as investor_name, i.mobile as investor_mobile,
         a.name as recorded_by_name
    from payments p
    join installments inst on inst.id = p.installment_id
    join investments v on v.id = inst.investment_id
    join investors i on i.id = v.investor_id
    left join admins a on a.id = p.recorded_by_admin_id`;

export async function getPayment(id, client = undefined) {
  const res = await query(`${PAYMENT_SELECT} where p.id = $1`, [id], client);
  if (!res.rows[0]) throw notFound('Payment not found');
  return res.rows[0];
}

export async function getPaymentByGatewayId(gatewayPaymentId, client = undefined) {
  const res = await query(`${PAYMENT_SELECT} where p.gateway_payment_id = $1`, [gatewayPaymentId], client);
  return res.rows[0] ?? null;
}

export async function listPayments(filters = {}, client = undefined) {
  const where = [];
  const params = [];
  const push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (filters.status) {
    const list = Array.isArray(filters.status) ? filters.status : [filters.status];
    where.push(`p.status = any(${push(list)})`);
  }
  if (filters.method) where.push(`p.method = ${push(filters.method)}`);
  if (filters.gateway) where.push(`p.gateway = ${push(filters.gateway)}`);
  if (filters.investorId) where.push(`i.id = ${push(filters.investorId)}`);
  if (filters.investmentId) where.push(`v.id = ${push(filters.investmentId)}`);
  if (filters.installmentId) where.push(`p.installment_id = ${push(filters.installmentId)}`);
  if (filters.from) where.push(`p.created_at >= ${push(filters.from)}`);
  if (filters.to) where.push(`p.created_at <= ${push(filters.to)}`);
  if (filters.paidFrom) where.push(`p.paid_at >= ${push(filters.paidFrom)}`);
  if (filters.paidTo) where.push(`p.paid_at < (${push(filters.paidTo)}::date + interval '1 day')`);
  if (filters.search) {
    const term = `%${String(filters.search).toLowerCase().trim()}%`;
    where.push(
      `(i.search_text like ${push(term)} or lower(coalesce(p.trx_id,'')) like $${params.length} or lower(coalesce(p.manual_reference,'')) like $${params.length} or cast(p.id as text) = $${params.length})`,
    );
  }
  if (filters.stuckOlderThanMinutes) {
    where.push(
      `p.status in ('INITIATED','PENDING') and p.created_at < now() - (${push(String(filters.stuckOlderThanMinutes))} || ' minutes')::interval and p.gateway <> 'MANUAL'`,
    );
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const limit = Math.min(Number(filters.limit) || 25, 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const rows = await query(
    `${PAYMENT_SELECT} ${whereSql} order by p.created_at desc, p.id desc limit ${push(limit)} offset ${push(offset)}`,
    params,
    client,
  );
  const total = await query(
    `select count(*)::int as count,
            coalesce(sum(case when p.status = 'SUCCESS' then p.amount else 0 end), 0)::bigint as success_amount
       from payments p
       join installments inst on inst.id = p.installment_id
       join investments v on v.id = inst.investment_id
       join investors i on i.id = v.investor_id ${whereSql}`,
    params.slice(0, params.length - 2),
    client,
  );
  return { rows: rows.rows, total: total.rows[0].count, successAmount: total.rows[0].success_amount, limit, offset };
}

/**
 * Stuck payments for the reconciliation job: INITIATED/PENDING older than the
 * configured threshold, gateway payments only, oldest first.
 */
export async function findStuckPayments({ olderThanMinutes = config.payments.reconcileStuckAfterMinutes, limit = 25 } = {}, client = undefined) {
  const res = await query(
    `${PAYMENT_SELECT}
      where p.status in ('INITIATED','PENDING')
        and p.gateway <> 'MANUAL'
        and p.gateway_payment_id is not null
        and p.created_at < now() - ($1 || ' minutes')::interval
      order by p.created_at asc
      limit $2`,
    [String(olderThanMinutes), limit],
    client,
  );
  return res.rows;
}

/** Give up on payments the gateway never completes (keeps the queue clean). */
export async function expireAbandonedPayments({ olderThanHours = 24 } = {}, client = undefined) {
  const res = await query(
    `update payments
        set status = 'CANCELLED', failure_reason = 'Abandoned: no gateway confirmation within ' || $1 || ' hours'
      where status = 'PENDING' and gateway <> 'MANUAL' and created_at < now() - ($1 || ' hours')::interval
      returning id`,
    [String(olderThanHours)],
    client,
  );
  return res.rows;
}

export function summarizePaymentForPublic(payment) {
  return {
    id: payment.id,
    status: payment.status,
    amount: Number(payment.amount),
    trxId: payment.trx_id,
    method: payment.method,
    paidAt: payment.paid_at,
    receiptNumber: `RCPT-${new Date(payment.created_at).getFullYear()}-${String(payment.id).padStart(6, '0')}`,
  };
}

export { deriveStatus, dhakaDate };
