import { ok } from '../utils/http.js';
import { parsePagination, paged } from '../utils/pagination.js';
import * as audit from '../services/audit.service.js';

export async function list(req, res) {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
  const result = await audit.list({
    adminId: req.query.adminId ? Number(req.query.adminId) : undefined,
    action: req.query.action,
    entity: req.query.entity,
    entityId: req.query.entityId,
    from: req.query.from,
    to: req.query.to,
    search: req.query.search ? String(req.query.search).slice(0, 80) : undefined,
    limit,
    offset,
  });
  return ok(res, paged({ rows: result.rows, total: result.total, limit, offset }));
}

export async function filters(req, res) {
  const values = await audit.distinctValues();
  return ok(res, values);
}
