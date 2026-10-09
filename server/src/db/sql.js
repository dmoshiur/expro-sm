/**
 * SQL helpers shared by services, jobs and migrations.
 */
import { stripLiteralsAndComments } from './values.js';

/** Current UTC timestamp in the storage format. Use inside SQL text: `${NOW}`. */
export const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * Builds a predicate `column in (?start, ?start+1, ...)` and its arguments.
 * An empty list yields `1 = 0` (matches nothing), never invalid "IN ()" SQL.
 *
 * @example const c = inClause('p.id', ids, args.length + 1); where.push(c.sql); args.push(...c.args);
 */
export function inClause(column, values, start = 1) {
  if (!values || values.length === 0) return { sql: '1 = 0', args: [] };
  const placeholders = values.map((_, i) => `?${start + i}`).join(', ');
  return { sql: `${column} in (${placeholders})`, args: [...values] };
}

/**
 * Splits a migration script into statements. Handles single-quoted strings and
 * comments, and keeps CREATE TRIGGER ... BEGIN ...; ... END; bodies together.
 * Note: a CASE ... END as the last token of a statement inside a trigger body
 * would be mistaken for the end of the trigger; avoid that pattern in triggers.
 */
export function splitSqlStatements(script) {
  const statements = [];
  const text = String(script);
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      buf += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      buf += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") {
          j += 2;
        } else if (text[j] === "'") {
          j += 1;
          break;
        } else {
          j += 1;
        }
      }
      buf += text.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ';') {
      const code = stripLiteralsAndComments(buf).trim();
      const inTriggerBody = /\bcreate\s+(temp\s+)?trigger\b/i.test(code) && !/\bend$/i.test(code);
      if (inTriggerBody) {
        buf += ch;
      } else if (code) {
        statements.push(buf.trim());
        buf = '';
      } else {
        buf = '';
      }
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  const rest = buf.trim();
  if (stripLiteralsAndComments(rest).trim()) statements.push(rest);
  return statements;
}
