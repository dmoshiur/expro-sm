/**
 * In-app support / inquiries.
 *
 * One ticket = one conversation between an investor and the office. Investors
 * can only ever address their own tickets (portal controller derives the
 * investor id from the session). Staff reply from the admin inbox and move the
 * ticket through OPEN -> IN_PROGRESS -> RESOLVED -> CLOSED.
 */
import { query, withTransaction } from '../db/client.js';
import { NOW } from '../db/sql.js';
import { badRequest, notFound } from '../utils/errors.js';
import { maskMobile } from '../utils/mask.js';
import * as audit from './audit.service.js';

export const TICKET_CATEGORIES = ['GENERAL', 'PAYMENT', 'PENSION', 'WALLET', 'PROFILE', 'DOCUMENT'];
export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const CLOSED = ['RESOLVED', 'CLOSED'];

export const categoryLabel = (value) =>
  ({ GENERAL: 'General', PAYMENT: 'Payment', PENSION: 'Pension', WALLET: 'Wallet', PROFILE: 'Profile', DOCUMENT: 'Documents' })[value] ?? value;
export const statusLabel = (value) =>
  ({ OPEN: 'Open', IN_PROGRESS: 'In progress', RESOLVED: 'Resolved', CLOSED: 'Closed' })[value] ?? value;

function presentTicket(row, { includeInvestor = false } = {}) {
  const ticket = {
    ...row,
    category_label: categoryLabel(row.category),
    status_label: statusLabel(row.status),
  };
  if (includeInvestor && row.investor_mobile) ticket.investor_mobile_masked = maskMobile(row.investor_mobile);
  return ticket;
}

async function loadOwnTicket(investorId, ticketId, client = undefined) {
  const res = await query(
    'select * from support_tickets where id = ?1 and investor_id = ?2',
    [ticketId, investorId],
    client,
  );
  if (!res.rows[0]) throw notFound('Ticket not found');
  return res.rows[0];
}

async function listMessages(ticketId, client = undefined) {
  const res = await query(
    `select m.id, m.ticket_id, m.author_type, m.body, m.created_at,
            a.name as admin_name, i.name as investor_name
       from support_messages m
       left join admins a on a.id = m.admin_id
       left join investors i on i.id = m.investor_id
      where m.ticket_id = ?1
      order by m.created_at asc, m.id asc`,
    [ticketId],
    client,
  );
  return res.rows.map((row) => ({
    ...row,
    author: row.author_type === 'ADMIN' ? row.admin_name || 'Support team' : row.investor_name || 'You',
  }));
}

async function nextTicketNo(client, id) {
  return `TKT-${String(id).padStart(6, '0')}`;
}

/** Investor: open a new inquiry with an initial message. */
export async function createTicket(investorId, { subject, category = 'GENERAL', priority = 'NORMAL', message }, req) {
  return withTransaction(async (client) => {
    const investor = await query(
      'select id, name, deleted_at from investors where id = ?1',
      [investorId],
      client,
    );
    if (!investor.rows[0] || investor.rows[0].deleted_at) throw notFound('Investor not found');

    const inserted = await query(
      `insert into support_tickets (ticket_no, investor_id, subject, category, priority, status, last_message_at, last_message_by)
       values (?1, ?2, ?3, ?4, ?5, 'OPEN', ${NOW}, 'INVESTOR') returning id`,
      [`TMP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, investorId, subject, category, priority],
      client,
    );
    const id = inserted.rows[0].id;
    const ticketNo = await nextTicketNo(client, id);
    await query('update support_tickets set ticket_no = ?2 where id = ?1', [id, ticketNo], client);
    await query(
      `insert into support_messages (ticket_id, author_type, investor_id, body)
       values (?1, 'INVESTOR', ?2, ?3)`,
      [id, investorId, message],
      client,
    );
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.SUPPORT_TICKET_CREATED,
        entity: 'support_ticket',
        entityId: id,
        newValue: { ticket_no: ticketNo, subject, category, priority },
        meta: { self: true, investorId },
        req,
      },
      client,
    );
    return getTicket(id, { client, forInvestorId: investorId });
  });
}

/** Investor: own ticket list (newest activity first). */
export async function listOwnTickets(investorId, { limit = 50 } = {}) {
  const res = await query(
    `select t.*, (select count(*) from support_messages m where m.ticket_id = t.id) as message_count
       from support_tickets t
      where t.investor_id = ?1
      order by t.last_message_at desc, t.id desc
      limit ?2`,
    [investorId, Math.min(Number(limit) || 50, 100)],
  );
  return res.rows.map((row) => presentTicket(row));
}

/** Investor: one own ticket + conversation. */
export async function getOwnTicket(investorId, ticketId) {
  const ticket = await loadOwnTicket(investorId, ticketId);
  return {
    ticket: presentTicket(ticket),
    messages: await listMessages(ticketId),
  };
}

/** Investor: reply while the ticket is still open. */
export async function addOwnMessage(investorId, ticketId, { body }, req) {
  return withTransaction(async (client) => {
    const ticket = await loadOwnTicket(investorId, ticketId, client);
    if (ticket.status === 'CLOSED') throw badRequest('This ticket is closed. Please open a new inquiry.');
    await query(
      `insert into support_messages (ticket_id, author_type, investor_id, body)
       values (?1, 'INVESTOR', ?2, ?3)`,
      [ticketId, investorId, body],
      client,
    );
    const status = ticket.status === 'RESOLVED' ? 'OPEN' : ticket.status;
    await query(
      `update support_tickets set status = ?2, last_message_at = ${NOW}, last_message_by = 'INVESTOR', closed_at = null
        where id = ?1`,
      [ticketId, status],
      client,
    );
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.SUPPORT_TICKET_REPLIED,
        entity: 'support_ticket',
        entityId: ticketId,
        newValue: { by: 'INVESTOR', status },
        meta: { self: true, investorId },
        req,
      },
      client,
    );
    return getOwnTicket(investorId, ticketId);
  });
}

/** Investor: close own ticket. */
export async function closeOwnTicket(investorId, ticketId, req) {
  return withTransaction(async (client) => {
    const ticket = await loadOwnTicket(investorId, ticketId, client);
    if (ticket.status !== 'CLOSED') {
      await query(
        `update support_tickets set status = 'CLOSED', closed_at = ${NOW}, last_message_at = ${NOW}, last_message_by = 'INVESTOR'
          where id = ?1`,
        [ticketId],
        client,
      );
      await audit.record(
        {
          action: audit.AUDIT_ACTIONS.SUPPORT_TICKET_STATUS_CHANGED,
          entity: 'support_ticket',
          entityId: ticketId,
          oldValue: { status: ticket.status },
          newValue: { status: 'CLOSED' },
          meta: { self: true, investorId },
          req,
        },
        client,
      );
    }
    return getOwnTicket(investorId, ticketId);
  });
}

/** Admin: ticket queue with filters. */
export async function listTickets({ status = null, category = null, search = null, limit = 50, offset = 0 } = {}) {
  const where = ['1 = 1'];
  const params = [];
  const push = (value) => {
    params.push(value);
    return `?${params.length}`;
  };
  if (status) where.push(`t.status = ${push(status)}`);
  if (category) where.push(`t.category = ${push(category)}`);
  if (search) {
    const term = `%${String(search).toLowerCase().trim()}%`;
    where.push(`(lower(t.subject) like ${push(term)} or lower(t.ticket_no) like ?${params.length} or lower(i.name) like ?${params.length})`);
  }
  const whereSql = where.join(' and ');
  const rows = await query(
    `select t.*, i.name as investor_name, i.member_code, i.mobile as investor_mobile,
            (select count(*) from support_messages m where m.ticket_id = t.id) as message_count
       from support_tickets t
       join investors i on i.id = t.investor_id
      where ${whereSql}
      order by case t.status when 'OPEN' then 0 when 'IN_PROGRESS' then 1 when 'RESOLVED' then 2 else 3 end,
               t.last_message_at desc
      limit ${push(Math.min(Number(limit) || 50, 100))} offset ${push(Math.max(Number(offset) || 0, 0))}`,
    params,
  );
  const countParams = params.slice(0, params.length - 2);
  const total = await query(
    `select count(*) as count from support_tickets t join investors i on i.id = t.investor_id where ${whereSql}`,
    countParams,
  );
  return {
    rows: rows.rows.map((row) => presentTicket(row, { includeInvestor: true })),
    total: Number(total.rows[0]?.count ?? 0),
  };
}

/** Admin: one ticket + conversation (works for any investor). */
export async function getTicket(ticketId, { client = undefined, forInvestorId = null } = {}) {
  const res = await query(
    `select t.*, i.name as investor_name, i.member_code, i.mobile as investor_mobile, i.status as investor_status
       from support_tickets t join investors i on i.id = t.investor_id
      where t.id = ?1`,
    [ticketId],
    client,
  );
  const ticket = res.rows[0];
  if (!ticket) throw notFound('Ticket not found');
  if (forInvestorId !== null && Number(ticket.investor_id) !== Number(forInvestorId)) throw notFound('Ticket not found');
  return {
    ticket: presentTicket(ticket, { includeInvestor: true }),
    messages: await listMessages(ticketId, client),
  };
}

/** Admin: reply. Replying to a resolved/closed ticket reopens it. */
export async function replyToTicket(ticketId, { body, status = null }, actor, req) {
  if (status && !TICKET_STATUSES.includes(status)) throw badRequest('Invalid ticket status');
  return withTransaction(async (client) => {
    const res = await query('select * from support_tickets where id = ?1', [ticketId], client);
    const ticket = res.rows[0];
    if (!ticket) throw notFound('Ticket not found');
    if (ticket.status === 'CLOSED') throw badRequest('Reopen the ticket before replying');

    await query(
      `insert into support_messages (ticket_id, author_type, admin_id, body)
       values (?1, 'ADMIN', ?2, ?3)`,
      [ticketId, actor?.id ?? null, body],
      client,
    );
    const nextStatus = status ?? (ticket.status === 'OPEN' ? 'IN_PROGRESS' : ticket.status);
    await query(
      `update support_tickets
          set status = ?2, last_message_at = ${NOW}, last_message_by = 'ADMIN', assigned_to = coalesce(?3, assigned_to)
        where id = ?1`,
      [ticketId, nextStatus, actor?.id ?? null],
      client,
    );
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.SUPPORT_TICKET_REPLIED,
        entity: 'support_ticket',
        entityId: ticketId,
        oldValue: { status: ticket.status },
        newValue: { by: 'ADMIN', status: nextStatus },
        actor,
        req,
      },
      client,
    );
    return getTicket(ticketId, { client });
  });
}

/** Admin: change ticket status. */
export async function setTicketStatus(ticketId, { status, note = null }, actor, req) {
  if (!TICKET_STATUSES.includes(status)) throw badRequest('Invalid ticket status');
  return withTransaction(async (client) => {
    const res = await query('select * from support_tickets where id = ?1', [ticketId], client);
    const ticket = res.rows[0];
    if (!ticket) throw notFound('Ticket not found');
    const closedAt = status === 'CLOSED' || status === 'RESOLVED' ? NOW : 'null';
    await query(
      `update support_tickets set status = ?2, closed_at = ${closedAt}, last_message_at = ${NOW}
        where id = ?1`,
      [ticketId, status],
      client,
    );
    if (note) {
      await query(
        `insert into support_messages (ticket_id, author_type, admin_id, body)
         values (?1, 'ADMIN', ?2, ?3)`,
        [ticketId, actor?.id ?? null, note],
        client,
      );
    }
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.SUPPORT_TICKET_STATUS_CHANGED,
        entity: 'support_ticket',
        entityId: ticketId,
        oldValue: { status: ticket.status },
        newValue: { status },
        actor,
        req,
      },
      client,
    );
    return getTicket(ticketId, { client });
  });
}

export async function countOpenTickets() {
  const res = await query("select count(*) as count from support_tickets where status in ('OPEN', 'IN_PROGRESS')");
  return Number(res.rows[0]?.count ?? 0);
}
