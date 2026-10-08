/**
 * Hand-written validation helpers. No schema library: a tiny builder that
 * collects field errors and throws one 422 with a field -> message map.
 */
import { AppError } from './errors.js';
import { isValidIsoDate } from './dates.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
/** Bangladeshi mobile: 01[3-9]XXXXXXXX, optional +88/88 country code. */
export const BD_MOBILE_RE = /^(?:\+?88)?01[3-9]\d{8}$/;

export function normalizeBdMobile(value) {
  const digits = String(value ?? '').replace(/[^\d+]/g, '');
  const m = BD_MOBILE_RE.exec(digits);
  if (!m) return null;
  const local = digits.replace(/^\+?88/, '');
  return local;
}

export function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());
}

export function isValidBdMobile(value) {
  return normalizeBdMobile(value) !== null;
}

/** NID: 10, 13 or 17 digits (Bangladesh: old 13/17 digit, new 10 digit smart card). */
export function isValidNid(value) {
  return /^\d{10}$|^\d{13}$|^\d{17}$/.test(String(value ?? '').replace(/\s|-/g, ''));
}

export const cleanNid = (value) => String(value ?? '').replace(/\s|-/g, '');

export class Validator {
  constructor(input = {}) {
    this.input = input && typeof input === 'object' ? input : {};
    this.errors = {};
    this.values = {};
  }

  fail(field, message) {
    if (!this.errors[field]) this.errors[field] = message;
    return this;
  }

  has(field) {
    const v = this.input[field];
    return v !== undefined && v !== null && String(v).trim() !== '';
  }

  raw(field) {
    return this.input[field];
  }

  check(condition, field, message) {
    if (!condition) this.fail(field, message);
    return this;
  }

  string(field, { required = false, min = 0, max = 500, trim = true, pattern, label, allowEmpty = true } = {}) {
    const name = label || field;
    let value = this.input[field];
    if (value === undefined || value === null) {
      if (required) this.fail(field, `${name} is required`);
      return undefined;
    }
    value = String(value);
    if (trim) value = value.trim();
    if (value === '' && !required && allowEmpty) return undefined;
    if (required && value === '') {
      this.fail(field, `${name} is required`);
      return undefined;
    }
    if (value.length < min) this.fail(field, `${name} must be at least ${min} characters`);
    if (value.length > max) this.fail(field, `${name} must be at most ${max} characters`);
    if (pattern && !pattern.test(value)) this.fail(field, `${name} is not in the expected format`);
    if (!this.errors[field]) this.values[field] = value;
    return value;
  }

  email(field, { required = false, label = 'Email' } = {}) {
    const value = this.string(field, { required, max: 254, label });
    if (value === undefined) return undefined;
    const normalized = value.toLowerCase();
    if (!isValidEmail(normalized)) {
      this.fail(field, 'Enter a valid email address');
      return undefined;
    }
    this.values[field] = normalized;
    return normalized;
  }

  mobile(field, { required = false, label = 'Mobile number' } = {}) {
    const value = this.string(field, { required, max: 20, label });
    if (value === undefined) return undefined;
    const normalized = normalizeBdMobile(value);
    if (!normalized) {
      this.fail(field, 'Enter a valid Bangladeshi mobile number (e.g. 01712345678)');
      return undefined;
    }
    this.values[field] = normalized;
    return normalized;
  }

  nid(field, { required = false, label = 'NID' } = {}) {
    const value = this.string(field, { required, max: 25, label });
    if (value === undefined) return undefined;
    const normalized = cleanNid(value);
    if (!isValidNid(normalized)) {
      this.fail(field, 'NID must be 10, 13 or 17 digits');
      return undefined;
    }
    this.values[field] = normalized;
    return normalized;
  }

  int(field, { required = false, min = undefined, max = undefined, label } = {}) {
    const name = label || field;
    const raw = this.input[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.fail(field, `${name} is required`);
      return undefined;
    }
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isSafeInteger(value)) {
      if (Number.isFinite(value)) this.fail(field, `${name} must be a whole number`);
      else this.fail(field, `${name} must be a number`);
      return undefined;
    }
    if (min !== undefined && value < min) this.fail(field, `${name} must be at least ${min}`);
    if (max !== undefined && value > max) this.fail(field, `${name} must be at most ${max}`);
    if (!this.errors[field]) this.values[field] = value;
    return value;
  }

  bool(field, { required = false, label } = {}) {
    const raw = this.input[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.fail(field, `${label || field} is required`);
      return undefined;
    }
    if (typeof raw === 'boolean') {
      this.values[field] = raw;
      return raw;
    }
    const s = String(raw).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return (this.values[field] = true);
    if (['0', 'false', 'no', 'off'].includes(s)) return (this.values[field] = false);
    this.fail(field, `${label || field} must be true or false`);
    return undefined;
  }

  date(field, { required = false, label } = {}) {
    const raw = this.input[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.fail(field, `${label || field} is required`);
      return undefined;
    }
    const value = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).trim().slice(0, 10);
    if (!isValidIsoDate(value)) {
      this.fail(field, `${label || field} must be a valid date (YYYY-MM-DD)`);
      return undefined;
    }
    this.values[field] = value;
    return value;
  }

  oneOf(field, allowed, { required = false, label } = {}) {
    const value = this.string(field, { required, label });
    if (value === undefined) return undefined;
    if (!allowed.includes(value)) {
      this.fail(field, `${label || field} must be one of: ${allowed.join(', ')}`);
      return undefined;
    }
    this.values[field] = value;
    return value;
  }

  /**
   * Array of items built by `buildItem(item, index)` which returns the parsed
   * item (and should push its own errors through the provided sub-validator).
   */
  array(field, buildItem, { required = false, min = 0, max = 100, label } = {}) {
    const name = label || field;
    const raw = this.input[field];
    if (raw === undefined || raw === null) {
      if (required) this.fail(field, `${name} is required`);
      return undefined;
    }
    if (!Array.isArray(raw)) {
      this.fail(field, `${name} must be a list`);
      return undefined;
    }
    if (raw.length < min) this.fail(field, `${name} must contain at least ${min} item(s)`);
    if (raw.length > max) this.fail(field, `${name} must contain at most ${max} item(s)`);
    const items = [];
    raw.forEach((item, index) => {
      const sub = new Validator(item);
      const parsed = buildItem(item, index, sub);
      if (Object.keys(sub.errors).length > 0) {
        for (const [k, msg] of Object.entries(sub.errors)) this.fail(`${field}[${index}].${k}`, msg);
      } else {
        items.push(parsed);
      }
    });
    if (!this.errors[field] && !Object.keys(this.errors).some((k) => k.startsWith(`${field}[`))) {
      this.values[field] = items;
    }
    return items;
  }

  /** Throws a 422 when anything failed, otherwise returns the sanitised values. */
  result() {
    if (Object.keys(this.errors).length > 0) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', this.errors);
    }
    return this.values;
  }

  get ok() {
    return Object.keys(this.errors).length === 0;
  }
}

export function validate(schemaFn, payload) {
  const v = new Validator(payload);
  schemaFn(v);
  return v.result();
}

/** Used to validate route params (?page=, ?limit=) without throwing. */
export function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export const LIMITS = {
  name: 120,
  address: 500,
  notes: 2000,
  reason: 500,
  password: { min: 12, max: 200 },
};
