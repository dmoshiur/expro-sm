/**
 * CSV export helpers. Excel-friendly: UTF-8 BOM prefix, CRLF line endings and
 * quote escaping. No dependency.
 */
export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (/[",\r\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** rows: array of arrays. header: array of strings (optional). */
export function toCsv(rows, header = null) {
  const lines = [];
  if (header) lines.push(header.map(csvEscape).join(','));
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Format poisha as a plain decimal string ("1234.50") for spreadsheets. */
export function poishaToDecimalString(poisha) {
  const n = Number(poisha ?? 0);
  return (n / 100).toFixed(2);
}

export function csvFilename(base) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const safe = String(base).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
  return `${safe}-${stamp}.csv`;
}
