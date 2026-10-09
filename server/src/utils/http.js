/** Uniform response helpers: success bodies are always { data: ... }. */
export function ok(res, data = null, extra = {}) {
  return res.status(200).json({ data, ...extra });
}

export function created(res, data = null) {
  return res.status(201).json({ data });
}

export function noContent(res) {
  return res.status(204).end();
}

/** For HTML endpoints (receipts, printable reports). */
export function html(res, markup, { status = 200, filename = null } = {}) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (filename) res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  return res.status(status).send(markup);
}

export function csv(res, content, filename) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(content);
}

export function binary(res, buffer, { mime = 'application/octet-stream', filename = null, cache = 'private, no-store' } = {}) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', cache);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (filename) res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  return res.status(200).end(buffer);
}
