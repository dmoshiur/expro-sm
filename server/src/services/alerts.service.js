/**
 * Actionable alerts shown as banners on the investor profile (portal + admin).
 *
 * Everything here is derived from live ledger data - no extra state to drift:
 *   * overdue pension installments (count + outstanding)
 *   * money due now / this month
 *   * documents waiting for verification
 *   * pending wallet requests
 *   * open support tickets
 *   * profile fields still missing
 *   * membership approval + account freeze
 */
import { query } from '../db/client.js';
import { dhakaDate } from '../utils/dates.js';
import { formatBDT } from '../utils/money.js';
import { getWalletSummary } from './wallet.service.js';

const OPEN = "('PENDING','PARTIALLY_PAID','OVERDUE')";

const PROFILE_LABELS = {
  name_bangla: 'Name (Bangla)',
  father_name: 'Father / husband name',
  mother_name: "Mother's name",
  date_of_birth: 'Date of birth',
  religion: 'Religion',
  education: 'Education',
  present_address: 'Present address',
  permanent_address: 'Permanent address',
  email: 'Email address',
  alternate_mobile: 'Alternate mobile',
};

export async function getInvestorAlerts(investorId, { includeProfileGaps = true } = {}) {
  const today = dhakaDate();
  const investorRes = await query(
    `select id, name, name_bangla, father_name, mother_name, date_of_birth, religion, education,
            present_address, permanent_address, email, alternate_mobile, address,
            status, membership_status, frozen_at, frozen_reason, deleted_at,
            (photo is not null) as has_photo, (nid_scan is not null) as has_nid_scan, nid_last4,
            created_at
       from investors where id = ?1`,
    [investorId],
  );
  const investor = investorRes.rows[0];
  if (!investor) return { items: [], summary: null };

  const [instRes, docRes, walletRes, ticketRes, nomineeRes] = await Promise.all([
    query(
      `select
         coalesce(sum(case when inst.status in ${OPEN} and inst.due_date < ?2 then inst.amount - inst.amount_paid else 0 end), 0) as overdue_amount,
         coalesce(sum(case when inst.status in ${OPEN} and inst.due_date < ?2 then 1 else 0 end), 0) as overdue_count,
         coalesce(sum(case when inst.status in ${OPEN} and inst.due_date <= ?2 then inst.amount - inst.amount_paid else 0 end), 0) as due_now_amount,
         coalesce(sum(case when inst.status in ${OPEN} and inst.due_date <= ?2 then 1 else 0 end), 0) as due_now_count,
         coalesce(sum(case when inst.status in ${OPEN} and substr(inst.due_date, 1, 7) = substr(?2, 1, 7)
                            then inst.amount - inst.amount_paid else 0 end), 0) as due_this_month_amount,
         min(case when inst.status in ${OPEN} then inst.due_date end) as next_due_date,
         coalesce(sum(inst.amount_paid), 0) as total_paid,
         coalesce(sum(case when inst.status in ${OPEN} then inst.amount - inst.amount_paid else 0 end), 0) as outstanding,
         coalesce(sum(case when inst.status = 'PAID' then 1 else 0 end), 0) as paid_installments,
         count(inst.id) as total_installments
       from installments inst join investments v on v.id = inst.investment_id
      where v.investor_id = ?1 and v.status <> 'CANCELLED' and inst.status <> 'CANCELLED'`,
      [investorId, today],
    ),
    query(
      `select count(*) as count from investor_documents where investor_id = ?1 and status = 'PENDING'`,
      [investorId],
    ),
    getWalletSummary(investorId),
    query(
      `select count(*) as count from support_tickets where investor_id = ?1 and status in ('OPEN','IN_PROGRESS')`,
      [investorId],
    ),
    query('select count(*) as count, coalesce(sum(share_percent), 0) as shares from nominees where investor_id = ?1', [investorId]),
  ]);

  const inst = instRes.rows[0] ?? {};
  const summary = {
    overdue_count: Number(inst.overdue_count ?? 0),
    overdue_amount: Number(inst.overdue_amount ?? 0),
    due_now_count: Number(inst.due_now_count ?? 0),
    due_now_amount: Number(inst.due_now_amount ?? 0),
    due_this_month_amount: Number(inst.due_this_month_amount ?? 0),
    next_due_date: inst.next_due_date ?? null,
    outstanding: Number(inst.outstanding ?? 0),
    total_paid: Number(inst.total_paid ?? 0),
    paid_installments: Number(inst.paid_installments ?? 0),
    total_installments: Number(inst.total_installments ?? 0),
    wallet_balance: walletRes.balance,
    wallet_available: walletRes.available_balance,
    pending_wallet_requests: walletRes.pending_requests,
    unverified_documents: Number(docRes.rows[0]?.count ?? 0),
    open_tickets: Number(ticketRes.rows[0]?.count ?? 0),
    nominees: Number(nomineeRes.rows[0]?.count ?? 0),
  };

  const items = [];
  if (investor.deleted_at) {
    items.push({
      key: 'deleted',
      tone: 'danger',
      title: 'Account deleted',
      message: 'This investor is soft-deleted. Restore the account before collecting further payments.',
      action: 'profile',
    });
  }
  if (investor.frozen_at) {
    items.push({
      key: 'frozen',
      tone: 'danger',
      title: 'Account frozen',
      message: `Money movement is blocked${investor.frozen_reason ? `: ${investor.frozen_reason}` : '.'}`,
      action: 'profile',
    });
  }
  if (investor.membership_status === 'PENDING') {
    items.push({
      key: 'membership_pending',
      tone: 'warn',
      title: 'Membership approval pending',
      message: 'Verify the photo, NID and signature, then approve the membership.',
      action: 'profile',
    });
  } else if (investor.membership_status === 'REJECTED') {
    items.push({
      key: 'membership_rejected',
      tone: 'danger',
      title: 'Membership rejected',
      message: 'The member must correct the documents and be approved again.',
      action: 'profile',
    });
  }
  if (summary.overdue_count > 0) {
    items.push({
      key: 'overdue',
      tone: 'danger',
      title: `${summary.overdue_count} overdue installment${summary.overdue_count === 1 ? '' : 's'}`,
      message: `${formatBDT(summary.overdue_amount)} outstanding since joining (${summary.overdue_count} unrecorded). Late payment may attract a fee.`,
      amount: summary.overdue_amount,
      action: 'installments',
    });
  }
  if (summary.due_now_count > summary.overdue_count) {
    items.push({
      key: 'due_now',
      tone: 'warn',
      title: 'Monthly installment due',
      message: `${formatBDT(summary.due_now_amount)} is due now (${summary.due_now_count} installment${summary.due_now_count === 1 ? '' : 's'}).`,
      amount: summary.due_now_amount,
      action: 'installments',
    });
  }
  if (summary.unverified_documents > 0) {
    items.push({
      key: 'documents',
      tone: 'info',
      title: 'Documents awaiting verification',
      message: `${summary.unverified_documents} uploaded document${summary.unverified_documents === 1 ? '' : 's'} need a Super Admin review.`,
      action: 'profile',
    });
  }
  if (summary.pending_wallet_requests > 0) {
    items.push({
      key: 'wallet',
      tone: 'info',
      title: 'Wallet request pending',
      message: `${summary.pending_wallet_requests} deposit / withdrawal request${summary.pending_wallet_requests === 1 ? '' : 's'} waiting for a decision.`,
      action: 'wallet',
    });
  }
  if (summary.open_tickets > 0) {
    items.push({
      key: 'tickets',
      tone: 'info',
      title: 'Open support inquiry',
      message: `${summary.open_tickets} ticket${summary.open_tickets === 1 ? '' : 's'} still open.`,
      action: 'support',
    });
  }

  if (includeProfileGaps) {
    const missing = Object.entries(PROFILE_LABELS)
      .filter(([field]) => !investor[field])
      .map(([field, label]) => ({ field, label }));
    if (!investor.has_photo) missing.push({ field: 'photo', label: 'Profile photo' });
    if (!investor.nid_last4) missing.push({ field: 'nid', label: 'NID number' });
    if (!investor.has_nid_scan) missing.push({ field: 'nid_front', label: 'NID scan' });
    if (summary.nominees === 0) missing.push({ field: 'nominees', label: 'Nominee' });
    summary.missing_profile_fields = missing;
    if (missing.length > 0) {
      items.push({
        key: 'profile',
        tone: 'muted',
        title: 'Profile incomplete',
        message: `Missing: ${missing.slice(0, 5).map((m) => m.label).join(', ')}${missing.length > 5 ? ` +${missing.length - 5} more` : ''}.`,
        action: 'profile',
      });
    }
  }

  return { items, summary, today };
}
