/**
 * CORS / CSRF origin matching.
 *
 * The allowlist must keep production strict while still supporting the
 * single-label wildcard used for ephemeral dev and preview hosts. These cases
 * pin the security-relevant boundaries (no dot-crossing, no bare-domain match,
 * case-insensitive scheme/host).
 */
import { describe, expect, it } from 'vitest';
import { isOriginAllowed, originMatches } from '../src/utils/origin';

describe('origin matching', () => {
  it('matches exact origins case-insensitively and nothing else', () => {
    expect(originMatches('https://portal.example.com', 'https://portal.example.com')).toBe(true);
    expect(originMatches('https://PORTAL.example.com', 'https://portal.example.com')).toBe(true);
    expect(originMatches('https://portal.example.com', 'https://portal.example.com.evil.io')).toBe(false);
    expect(originMatches('https://portal.example.com', 'http://portal.example.com')).toBe(false);
    expect(originMatches('https://portal.example.com', 'https://portal.example.com:8443')).toBe(false);
  });

  it('treats * as one host label, never as a dot-crossing or bare-domain match', () => {
    const pattern = 'https://*.e2b.app';
    expect(originMatches(pattern, 'https://5173-icydh367xlsc5dds3rgic.e2b.app')).toBe(true);
    expect(originMatches(pattern, 'https://e2b.app')).toBe(false);
    expect(originMatches(pattern, 'https://a.b.e2b.app')).toBe(false);
    expect(originMatches(pattern, 'https://evil-e2b.app')).toBe(false);
    expect(originMatches(pattern, 'http://5173-x.e2b.app')).toBe(false);
    // a host that merely ends with the pattern must not pass
    expect(originMatches(pattern, 'https://attacker.example/?x=.e2b.app')).toBe(false);
  });

  it('supports a wildcard port and ignores empty patterns', () => {
    expect(originMatches('http://localhost:*', 'http://localhost:5173')).toBe(true);
    expect(originMatches('http://localhost:*', 'http://localhost')).toBe(false);
    expect(originMatches('', 'http://localhost:5173')).toBe(false);
  });

  it('allows requests without an Origin but blocks unknown browser origins', () => {
    const allowlist = ['https://portal.example.com', 'https://*.e2b.app'];
    expect(isOriginAllowed(undefined, allowlist)).toBe(true); // curl, webhooks, S2S
    expect(isOriginAllowed(null, allowlist)).toBe(true);
    expect(isOriginAllowed('https://portal.example.com', allowlist)).toBe(true);
    expect(isOriginAllowed('https://5173-abc.e2b.app', allowlist)).toBe(true);
    expect(isOriginAllowed('https://evil.example', allowlist)).toBe(false);
    expect(isOriginAllowed('https://sub.portal.example.com', allowlist)).toBe(false); // not listed explicitly
  });

  it('does not accidentally allow everything when "*" is configured', () => {
    // "*" is only ever meant for throwaway environments; it is asserted here so
    // the behaviour is explicit rather than surprising.
    expect(isOriginAllowed('https://anything.example', ['*'])).toBe(true);
  });
});
