/** Small HTTP helpers: pagination parsing, first-name extraction, etc. */
import { z } from 'zod';
import { serializeMoney } from './money';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

export function buildPaginated<T>(items: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return {
    items: serializeMoney(items),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export function skipTake(page: number, pageSize: number): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/** "Md. Rahim Uddin" -> "Md." (public payment page shows the first name only). */
export function firstName(fullName: string): string {
  return (fullName || '').trim().split(/\s+/)[0] ?? '';
}

export const getClientIp = (req: { ip?: string; headers: Record<string, unknown> }): string => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0]!.trim();
  return req.ip ?? 'unknown';
};

export const getUserAgent = (req: { headers: Record<string, unknown> }): string =>
  String(req.headers['user-agent'] ?? '').slice(0, 500);

/** Strips properties that a privilege level is not allowed to see. */
export function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
