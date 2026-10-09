/**
 * Minimal RFC 4180 CSV reader for the psql `\copy ... csv header` output.
 *
 * psql distinguishes NULL from empty text: an unquoted empty field is NULL, a
 * quoted empty field ("") is the empty string. This parser keeps that difference:
 * it returns null for NULL and '' for the empty string. Quoted fields may contain
 * commas, quotes (doubled), and newlines.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let wasQuoted = false;
  let atFieldStart = true;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(!wasQuoted && field === '' ? null : field);
    field = '';
    wasQuoted = false;
    atFieldStart = true;
  };
  const endRow = () => {
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (atFieldStart && c === '"') {
      wasQuoted = true;
      atFieldStart = false;
      i += 1;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        field += text[i];
        i += 1;
      }
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endField();
      endRow();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    atFieldStart = false;
    i += 1;
  }
  if (field !== '' || wasQuoted || row.length > 0) {
    endField();
    endRow();
  }
  return rows;
}
