import { describe, expect, it } from 'vitest';
import { assertHostedConfiguration, type HostedConfiguration } from '../src/config/production';

const productionConfig: HostedConfiguration = {
  isVercel: true,
  isVercelPreview: false,
  databaseUrl: 'libsql://investor-portal-example.turso.io',
  authToken: 'turso-secret',
  storageDriver: 'cloudinary',
  cloudinaryConfigured: true,
  bkashConfigured: true,
  bkashMode: 'live',
  bkashBaseUrl: 'https://tokenized.pay.bka.sh/v1.2.0-beta',
  smsProvider: 'bulksmsbd',
  smsConfigured: true,
  smsApiUrl: 'https://sms.example.com/send',
  cookieSecure: true,
  corsOrigins: ['https://portal.example.com'],
  appBaseUrl: 'https://portal.example.com',
  apiBaseUrl: 'https://portal.example.com',
  bkashCallbackUrl: 'https://portal.example.com/api/public/payments/bkash/callback',
  runJobs: false,
};

describe('hosted configuration guardrails', () => {
  it('accepts remote Turso, Cloudinary, HTTPS origins and real bKash credentials', () => {
    expect(() => assertHostedConfiguration(productionConfig)).not.toThrow();
  });

  it('rejects local database and filesystem fallbacks on Vercel', () => {
    expect(() =>
      assertHostedConfiguration({
        ...productionConfig,
        databaseUrl: 'file:./prisma/dev.db',
        authToken: undefined,
        storageDriver: 'auto',
        cloudinaryConfigured: false,
      }),
    ).toThrow(/hosted libSQL\/Turso database[\s\S]*STORAGE_DRIVER must be "cloudinary"/);
  });

  it('rejects simulated or insecure SMS gateways in production', () => {
    expect(() => assertHostedConfiguration({ ...productionConfig, smsProvider: 'console' })).toThrow(/SMS_PROVIDER=console/);
    expect(() => assertHostedConfiguration({ ...productionConfig, smsConfigured: false })).toThrow(/SMS_API_KEY and SMS_API_URL are required/);
    expect(() => assertHostedConfiguration({ ...productionConfig, smsApiUrl: 'http://sms.example.com/send' })).toThrow(/SMS_API_URL must use https/);
  });

  it('rejects the mock payment gateway and insecure production URLs', () => {
    expect(() => assertHostedConfiguration({ ...productionConfig, bkashMode: 'sandbox' })).toThrow(/must point to the sandbox/);
    expect(() =>
      assertHostedConfiguration({
        ...productionConfig,
        bkashConfigured: false,
        bkashBaseUrl: 'http://tokenized.pay.bka.sh/v1.2.0-beta',
        smsProvider: 'console',
        smsConfigured: false,
        smsApiUrl: 'http://sms.example.com/send',
        cookieSecure: false,
        corsOrigins: ['http://portal.example.com'],
      }),
    ).toThrow(/mock payment gateway is development\/test only[\s\S]*COOKIE_SECURE[\s\S]*https/i);
  });

  it('rejects embedded replicas on Vercel but permits an authenticated replica on a persistent host', () => {
    const replica = {
      ...productionConfig,
      isVercel: false,
      databaseUrl: 'file:./prisma/replica.db',
      syncUrl: 'libsql://investor-portal-example.turso.io',
    };

    expect(() => assertHostedConfiguration(replica)).not.toThrow();
    expect(() => assertHostedConfiguration({ ...replica, isVercel: true })).toThrow(/embedded replicas are not supported on Vercel/);
  });

  it('allows a single-label HTTPS wildcard only for Vercel Preview origins', () => {
    const preview = {
      ...productionConfig,
      isVercelPreview: true,
      corsOrigins: ['https://*.vercel.app'],
    };

    expect(() => assertHostedConfiguration(preview)).not.toThrow();
    expect(() => assertHostedConfiguration({ ...preview, isVercelPreview: false })).toThrow(/wildcards are only allowed/);
  });
});
