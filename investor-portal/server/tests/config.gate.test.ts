/**
 * The configuration gate: a deployment that is missing *core* settings must
 * explain itself with a 503 instead of crashing every request with an opaque
 * 500 FUNCTION_INVOCATION_FAILED. Feature scopes (storage/payments/sms) must not
 * take the rest of the API down with them.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { request } from './helpers/http';

const problem = (scope: 'core' | 'storage' | 'payments' | 'sms', message: string) => ({ scope, message });

describe('configuration gate', () => {
  it('answers 503 with the missing settings when a core problem exists', async () => {
    const app = createApp({
      configProblems: [
        problem('core', 'TURSO_AUTH_TOKEN is required for the hosted database'),
        problem('payments', 'all four BKASH_* credentials are required'),
      ],
    });

    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details.problems).toContain('TURSO_AUTH_TOKEN is required for the hosted database');
    // feature problems are listed too, so one redeploy fixes everything
    expect(res.body.error.details.problems).toContain('all four BKASH_* credentials are required');
    expect(res.body.error.details.scopes).toEqual(['core', 'payments']);
    expect(res.body.error.requestId).toBeTruthy();
    // never leak values or stack traces
    expect(JSON.stringify(res.body)).not.toMatch(/secret|password|token=/i);
  });

  it('does not gate feature-only problems: auth still answers normally', async () => {
    const app = createApp({
      configProblems: [problem('storage', 'STORAGE_DRIVER must be "cloudinary"'), problem('sms', 'SMS_PROVIDER=console is development/test-only')],
    });

    const res = await request(app).get('/api/auth/me');

    // no session -> the auth middleware answers 401, proving the request reached
    // the router instead of the gate
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
