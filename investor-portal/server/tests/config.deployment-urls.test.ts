/**
 * Public-URL resolution on hosted deployments.
 *
 * A Vercel deployment must never ship `http://localhost:...` values into payment
 * links, SMS links or the CORS allowlist, and must use its own origin instead.
 * A deliberate non-local value (another domain) must never be rewritten.
 */
import { describe, expect, it } from 'vitest';
import {
  deploymentOrigin,
  deploymentOrigins,
  isLocalUrl,
  resolveHostedOrigins,
  resolveHostedUrl,
} from '../src/config/deployment-urls';

const productionDeployment = {
  isVercel: true,
  vercelEnv: 'production',
  projectProductionUrl: 'expro-sm.vercel.app',
  deploymentUrl: 'expro-abc123-mdmoshiurrahmanmohi1-4430.vercel.app',
};

const previewDeployment = {
  isVercel: true,
  vercelEnv: 'preview',
  projectProductionUrl: 'expro-sm.vercel.app',
  deploymentUrl: 'expro-abc123-mdmoshiurrahmanmohi1-4430.vercel.app',
};

describe('isLocalUrl', () => {
  it('recognises loopback URLs with or without a port and path', () => {
    for (const value of [
      'http://localhost:5173',
      'https://localhost',
      'http://127.0.0.1:4000/api/public/payments/bkash/callback',
      'http://0.0.0.0:8080',
      'https://[::1]:3000/x',
    ]) {
      expect(isLocalUrl(value), value).toBe(true);
    }
  });

  it('does not treat real hosts as local', () => {
    for (const value of ['https://expro-sm.vercel.app', 'http://portal.example.com', 'https://localhost.evil.com', '']) {
      expect(isLocalUrl(value), value).toBe(false);
    }
  });
});

describe('deploymentOrigin', () => {
  it('prefers the project domain for production and the deployment URL for previews', () => {
    expect(deploymentOrigin(productionDeployment)).toBe('https://expro-sm.vercel.app');
    expect(deploymentOrigin(previewDeployment)).toBe('https://expro-abc123-mdmoshiurrahmanmohi1-4430.vercel.app');
  });

  it('has no origin outside Vercel or without Vercel-provided hosts', () => {
    expect(deploymentOrigin({ isVercel: false })).toBeUndefined();
    expect(deploymentOrigin({ isVercel: true, vercelEnv: 'production' })).toBeUndefined();
  });

  it('normalises a scheme and trailing slash in the provided host', () => {
    expect(deploymentOrigin({ isVercel: true, vercelEnv: 'production', projectProductionUrl: 'https://expro-sm.vercel.app/' })).toBe(
      'https://expro-sm.vercel.app',
    );
  });
});

describe('deploymentOrigins', () => {
  it('includes both the project domain and the deployment-specific host', () => {
    expect(deploymentOrigins(productionDeployment)).toEqual([
      'https://expro-sm.vercel.app',
      'https://expro-abc123-mdmoshiurrahmanmohi1-4430.vercel.app',
    ]);
  });

  it('deduplicates and tolerates missing hosts', () => {
    expect(deploymentOrigins({ isVercel: true, vercelEnv: 'production', projectProductionUrl: 'expro-sm.vercel.app' })).toEqual([
      'https://expro-sm.vercel.app',
    ]);
    expect(deploymentOrigins({ isVercel: true })).toEqual([]);
  });
});

describe('resolveHostedUrl', () => {
  const origin = 'https://expro-sm.vercel.app';

  it('replaces localhost and empty values with the deployment origin', () => {
    expect(resolveHostedUrl('APP_BASE_URL', 'http://localhost:5173', origin)).toMatchObject({ value: origin });
    expect(resolveHostedUrl('API_BASE_URL', '', origin)).toMatchObject({ value: origin });
    expect(resolveHostedUrl('APP_BASE_URL', 'http://localhost:5173', origin).note).toMatch(/APP_BASE_URL=http:\/\/localhost:5173/);
  });

  it('keeps a deliberate non-local value untouched (never a silent rewrite)', () => {
    const resolved = resolveHostedUrl('APP_BASE_URL', 'https://portal.example.com/', origin);
    expect(resolved).toEqual({ value: 'https://portal.example.com/' });
  });

  it('keeps the raw value when the runtime gave no fallback', () => {
    expect(resolveHostedUrl('APP_BASE_URL', 'http://localhost:5173', undefined)).toEqual({ value: 'http://localhost:5173' });
  });
});

describe('resolveHostedOrigins', () => {
  const origins = ['https://expro-sm.vercel.app', 'https://expro-abc123-mdmoshiurrahmanmohi1-4430.vercel.app'];

  it('replaces a localhost-only allowlist with the deployment origins (a same-origin SPA is always allowed)', () => {
    const resolved = resolveHostedOrigins(['http://localhost:5173'], origins);
    expect(resolved.origins).toEqual(origins);
    expect(resolved.notes[0]).toMatch(/localhost:5173/);
  });

  it('keeps real origins and drops only the loopback entries', () => {
    const resolved = resolveHostedOrigins(['https://portal.example.com', 'http://localhost:5173'], origins);
    expect(resolved.origins).toEqual(['https://portal.example.com', ...origins]);
  });

  it('leaves a usable allowlist untouched (the strict-CORS policy still applies)', () => {
    expect(resolveHostedOrigins(['http://portal.example.com'], origins)).toEqual({
      origins: ['http://portal.example.com'],
      notes: [],
    });
  });

  it('uses the deployment origins when the allowlist is unset', () => {
    expect(resolveHostedOrigins([], origins)).toMatchObject({ origins });
  });

  it('stays empty outside Vercel with nothing configured', () => {
    expect(resolveHostedOrigins(['http://localhost:5173'], [])).toEqual({ origins: [], notes: expect.any(Array) });
  });
});
