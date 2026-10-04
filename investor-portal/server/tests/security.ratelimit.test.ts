import { describe, expect, it, vi } from 'vitest';

/**
 * The rest of the suite runs with RATE_LIMIT_DISABLED=1 (one client IP), so the
 * limiter is verified here against a freshly imported app with limits enabled.
 */
describe('rate limiting (security)', () => {
  it('blocks brute-force login attempts after 10 tries per window', async () => {
    const previous = process.env.RATE_LIMIT_DISABLED;
    delete process.env.RATE_LIMIT_DISABLED;
    vi.resetModules();

    try {
      const { createApp } = await import('../src/app');
      const { default: request } = await import('supertest');
      const app = createApp();

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await request(app)
          .post('/api/auth/login')
          .send({ email: 'nobody@test.local', password: 'SomePassword1' });
        statuses.push(response.status);
      }

      expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(10);
      expect(statuses.at(-1)).toBe(429);
      expect(statuses.at(-2)).toBe(429);
      // draft-7 headers advertise the remaining quota
      const limited = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@test.local', password: 'SomePassword1' });
      expect(limited.headers['ratelimit-policy']).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.RATE_LIMIT_DISABLED;
      else process.env.RATE_LIMIT_DISABLED = previous;
      vi.resetModules();
    }
  });
});
