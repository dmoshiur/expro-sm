/**
 * Admin support / inquiries inbox (mounted at /api/support).
 * Investors reach the same records through /api/portal/support/*.
 */
import { Validator } from '../utils/validate.js';
import { ok, created } from '../utils/http.js';
import { badRequest } from '../utils/errors.js';
import { parsePagination, paged } from '../utils/pagination.js';
import * as supportService from '../services/support.service.js';
import { countPendingRequests } from '../services/wallet.service.js';

export async function list(req, res) {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const status = req.query.status ? String(req.query.status) : null;
  const category = req.query.category ? String(req.query.category) : null;
  if (status && !supportService.TICKET_STATUSES.includes(status)) throw badRequest('Invalid ticket status');
  if (category && !supportService.TICKET_CATEGORIES.includes(category)) throw badRequest('Invalid ticket category');
  const result = await supportService.listTickets({
    status,
    category,
    search: req.query.search ? String(req.query.search).slice(0, 80) : null,
    limit,
    offset,
  });
  return ok(res, paged({ rows: result.rows, total: result.total, limit, offset }));
}

export async function detail(req, res) {
  return ok(res, await supportService.getTicket(Number(req.params.id)));
}

/** POST /support/tickets/:id/messages { message, status? } */
export async function reply(req, res) {
  const v = new Validator(req.body);
  v.string('message', { required: true, min: 1, max: 4000, label: 'Message' });
  v.oneOf('status', supportService.TICKET_STATUSES, { required: false, label: 'Status' });
  const input = v.result();
  const result = await supportService.replyToTicket(
    Number(req.params.id),
    { body: input.message, status: input.status ?? null },
    req.admin,
    req,
  );
  return created(res, result);
}

/** POST /support/tickets/:id/status { status, note? } */
export async function setStatus(req, res) {
  const v = new Validator(req.body);
  v.oneOf('status', supportService.TICKET_STATUSES, { required: true, label: 'Status' });
  v.string('note', { required: false, max: 4000, label: 'Note' });
  const input = v.result();
  return ok(res, await supportService.setTicketStatus(Number(req.params.id), input, req.admin, req));
}

export async function summary(req, res) {
  const [open, pendingWallet] = await Promise.all([supportService.countOpenTickets(), countPendingRequests()]);
  return ok(res, { open_tickets: open, pending_wallet_requests: pendingWallet });
}
