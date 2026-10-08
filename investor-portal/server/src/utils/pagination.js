/** Query-string parsing helpers for list endpoints. */
import { parsePositiveInt } from './validate.js';

const SORTABLE = /^[a-z_][a-z0-9_.]{0,40}$/;

export function parsePagination(query = {}, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const limit = parsePositiveInt(query.limit, defaultLimit, maxLimit);
  const page = parsePositiveInt(query.page, 1, 10_000);
  return { limit, page, offset: (page - 1) * limit };
}

/**
 * Builds a safe `order by` clause: the column must be whitelisted by the caller.
 * `sort=name&dir=asc` - anything unknown falls back to the default.
 */
export function parseSort(query = {}, allowed, fallback = { column: 'created_at', direction: 'desc' }) {
  const column = String(query.sort ?? '').trim();
  const direction = String(query.dir ?? query.direction ?? fallback.direction).toLowerCase() === 'asc' ? 'asc' : 'desc';
  if (allowed.includes(column) && SORTABLE.test(column)) {
    return { column, direction, sql: `${column} ${direction}`, whitelisted: true };
  }
  return { column: fallback.column, direction: fallback.direction, sql: `${fallback.column} ${fallback.direction}`, whitelisted: false };
}

export function paged({ rows, total, limit, offset }) {
  const page = Math.floor(offset / limit) + 1;
  return {
    items: rows,
    meta: {
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      hasMore: offset + rows.length < total,
    },
  };
}
