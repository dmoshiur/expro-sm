/**
 * Browser origin allow-listing.
 *
 * The API is configured with a strict list of origins (`CORS_ORIGINS`). Exact
 * matches cover production. Development and ephemeral environments (sandbox
 * previews, PR deployments) get a stable URL per container, so a pattern with a
 * single `*` segment is supported as well:
 *
 *   https://*.example.com     ->  https://5173-abc.example.com  ✅
 *                                 https://a.b.example.com       ❌ (single label)
 *                                 https://evil.com              ❌
 *
 * The wildcard never crosses a dot and never matches the bare domain, so it
 * cannot be widened into an open redirect for subdomain takeovers.
 */

/** Escapes regex metacharacters except `*`, which becomes a single-label wildcard. */
export function originMatches(pattern: string, origin: string): boolean {
  if (!pattern) return false;
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern.toLowerCase() === origin.toLowerCase();

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*');
  return new RegExp(`^${escaped}$`, 'i').test(origin);
}

/**
 * True when the request may proceed.
 *
 * Requests without an `Origin` header (curl, server-to-server calls, gateway
 * webhooks) are allowed: they carry no browser session, so they cannot be
 * abused for CSRF and blocking them would only break integrations.
 */
export function isOriginAllowed(origin: string | undefined | null, patterns: readonly string[]): boolean {
  if (!origin) return true;
  return patterns.some((pattern) => originMatches(pattern, origin));
}

export const originUtils = { originMatches, isOriginAllowed };
export default originUtils;
