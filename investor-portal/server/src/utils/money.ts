/**
 * Money helpers.  RULE: all amounts live in the database as INTEGER POISHA.
 * 1 BDT = 100 poisha. Floats are never used for money.
 */
import { badRequest } from './errors';

export const POISHA_PER_BDT = 100;

export type Poisha = bigint;

/** Convert BDT (number of taka, e.g. 1234.56 or "1234.56") to poisha. */
export function bdtToPoisha(value: number | string): bigint {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw badRequest('Invalid amount');
    // round to 2 decimals using string math to dodge float artefacts
    return bdtToPoisha(value.toFixed(2));
  }
  const raw = value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw badRequest('Invalid amount format');
  const [taka, fraction = ''] = raw.split('.');
  const frac = (fraction + '00').slice(0, 2);
  return BigInt(taka) * BigInt(POISHA_PER_BDT) + BigInt(frac);
}

/** Convert poisha to a BDT number (for display / Excel only, never for storage). */
export function poishaToBdt(poisha: bigint | number): number {
  return Number(typeof poisha === 'bigint' ? poisha : BigInt(Math.trunc(poisha))) / POISHA_PER_BDT;
}

/** Format poisha as "12,345.67" (no currency symbol). */
export function formatPoisha(poisha: bigint | number): string {
  const value = typeof poisha === 'bigint' ? poisha : BigInt(Math.trunc(poisha));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const taka = abs / BigInt(POISHA_PER_BDT);
  const frac = (abs % BigInt(POISHA_PER_BDT)).toString().padStart(2, '0');
  const grouped = taka.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${frac}`;
}

/** Format poisha as "৳ 12,345.67" for receipts / UI / SMS. */
export function formatBdt(poisha: bigint | number): string {
  return `৳ ${formatPoisha(poisha)}`;
}

/**
 * Split a total into `count` installments of equal size, pushing the rounding
 * remainder into the LAST installment so the sum always equals the total.
 *
 * Example: 10,000.00 BDT over 3 -> 3,333.33 / 3,333.33 / 3,333.34
 */
export function splitIntoInstallments(totalPoisha: bigint | number, count: number): bigint[] {
  const total = typeof totalPoisha === 'bigint' ? totalPoisha : BigInt(Math.trunc(totalPoisha));
  if (count < 1) throw badRequest('Installment count must be at least 1');
  if (total <= 0n) throw badRequest('Total amount must be greater than zero');
  const n = BigInt(count);
  const base = total / n;
  if (base <= 0n) throw badRequest('Total amount is too small for the requested number of installments');
  const out: bigint[] = new Array(count).fill(base);
  const remainder = total - base * n;
  out[count - 1] = base + remainder;
  return out;
}

export function sumPoisha(values: Array<bigint | number>): bigint {
  return values.reduce<bigint>((acc, v) => acc + (typeof v === 'bigint' ? v : BigInt(Math.trunc(v))), 0n);
}

export function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(value);
}

/** Safe JSON serialisation (Prisma BigInt is not JSON-native). */
export function serializeMoney<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as T;
}

export const pct = (part: bigint, whole: bigint): number =>
  whole === 0n ? 0 : Number((part * 10000n) / whole) / 100;
