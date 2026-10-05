/**
 * Public-URL resolution for hosted deployments.
 *
 * A Vercel deployment knows its own public origin (`VERCEL_PROJECT_PRODUCTION_URL`
 * for production, `VERCEL_URL` for the deployment actually serving the request),
 * and the SPA and the API share that origin because `vercel.json` routes `/api/*`
 * to the server service on the same domain.
 *
 * Two problems this solves for a fresh deployment:
 *
 *   1. `.env.example` values such as `APP_BASE_URL=http://localhost:5173` get
 *      copied into the project settings. On a hosted runtime they are dead
 *      weight: payment links, SMS links and bKash redirects would point at the
 *      operator's laptop, and the CORS allowlist would reject the deployment's
 *      own SPA (a same-origin request must never be blocked).
 *   2. Operators forget to set them at all.
 *
 * Only *loopback* values (localhost / 127.0.0.1 / 0.0.0.0 / [::1]) are replaced,
 * and only on Vercel: a deliberate non-local value such as
 * `http://portal.example.com` or another domain is never rewritten - it stays a
 * normal configuration problem. Every replacement is reported so it shows up in
 * the deployment logs instead of happening silently.
 */
export interface DeploymentContext {
  /** true on Vercel (production and preview) */
  isVercel: boolean;
  /** VERCEL_ENV: 'production' | 'preview' | 'development' */
  vercelEnv?: string;
  /** VERCEL_PROJECT_PRODUCTION_URL (hostname, no scheme) */
  projectProductionUrl?: string;
  /** VERCEL_URL (hostname of this deployment, no scheme) */
  deploymentUrl?: string;
}

/** Matches http(s) URLs whose host is loopback, with or without a path. */
const LOCAL_URL_PATTERN = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i;

/** true for `http://localhost:5173`, `https://127.0.0.1:4000/api/...`, ... */
export const isLocalUrl = (value: string): boolean => LOCAL_URL_PATTERN.test(value.trim());

/**
 * Every https origin this deployment is reachable at, preferred one first.
 *
 * Both the project's production domain and the deployment-specific host are
 * included: the browser may reach the API through either one (the production
 * alias, or the per-deployment URL), and both are the project's own hosts.
 */
export function deploymentOrigins(context: DeploymentContext): string[] {
  if (!context.isVercel) return [];
  const hosts =
    context.vercelEnv === 'preview'
      ? [context.deploymentUrl, context.projectProductionUrl]
      : [context.projectProductionUrl, context.deploymentUrl];

  const origins: string[] = [];
  for (const host of hosts) {
    const clean = host
      ?.trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '');
    if (!clean) continue;
    const origin = `https://${clean}`;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/** The deployment's preferred https origin, or undefined when Vercel told us nothing. */
export function deploymentOrigin(context: DeploymentContext): string | undefined {
  return deploymentOrigins(context)[0];
}

export interface ResolvedUrl {
  value: string;
  /** Set when a local/empty value was replaced (for the startup log). */
  note?: string;
}

/**
 * Returns the value a hosted deployment should actually use: the explicit value
 * when it is usable, otherwise the deployment origin (fallback).
 */
export function resolveHostedUrl(name: string, explicit: string, fallback: string | undefined): ResolvedUrl {
  const value = explicit.trim();
  const usable = value.length > 0 && !isLocalUrl(value);

  if (usable || !fallback) return { value: explicit };
  return {
    value: fallback,
    note: `${name}=${value || '(unset)'} is not usable on a hosted deployment - using ${fallback}`,
  };
}

export interface ResolvedOrigins {
  origins: string[];
  notes: string[];
}

/**
 * Drops loopback entries from a CORS allowlist (they can never be an origin the
 * deployment talks to) and falls back to the deployment's own origin when
 * nothing usable is left. Non-local entries - including the ones the guardrails
 * later reject - are passed through untouched.
 */
export function resolveHostedOrigins(origins: readonly string[], fallbackOrigins: readonly string[]): ResolvedOrigins {
  if (origins.length === 0) {
    return fallbackOrigins.length > 0
      ? {
          origins: [...fallbackOrigins],
          notes: [`CORS_ORIGINS is unset - allowing the deployment origins ${fallbackOrigins.join(', ')}`],
        }
      : { origins: [], notes: [] };
  }

  const usable = origins.filter((origin) => !isLocalUrl(origin));
  const dropped = origins.filter((origin) => isLocalUrl(origin));

  if (dropped.length === 0) return { origins: [...origins], notes: [] };

  const cleaned = usable.length > 0 ? usable : [...fallbackOrigins];
  // The deployment's own origins are always allowed when a local value was
  // dropped, even if the operator also listed other real origins.
  const finalOrigins = [...cleaned];
  for (const origin of fallbackOrigins) {
    if (!finalOrigins.includes(origin)) finalOrigins.push(origin);
  }

  const replacement = finalOrigins.length > 0 ? ` - using ${finalOrigins.join(', ')}` : '';
  return {
    origins: finalOrigins,
    notes: [`CORS_ORIGINS contained ${dropped.join(', ')}, which no hosted browser can use${replacement}`],
  };
}
