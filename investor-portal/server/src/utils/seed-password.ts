import crypto from 'node:crypto';
import { passwordSchema } from '../validators/auth.validator';

const PASSWORD_POLICY_ERROR =
  '[seed] SEED_SUPER_ADMIN_PASSWORD must be 10-200 characters, include a letter and number, and have no outer spaces';

export interface SeedPasswordSelection {
  password: string;
  generated: boolean;
  invalidConfigured: boolean;
}

/**
 * Build a high-entropy password that always passes the application's password
 * policy. The fixed prefix guarantees at least one letter and one digit; the
 * remaining 256 random bits come from Node's cryptographic RNG.
 */
function generatePassword(): string {
  return `A1${crypto.randomBytes(32).toString('base64url')}`;
}

/**
 * Select the first super-admin password. An unset value has always generated a
 * one-time password. On Vercel Production, an invalid configured value does the
 * same rather than blocking the deployment; local and self-hosted runs remain
 * strict so configuration mistakes are caught during setup.
 */
export function resolveSeedPassword(
  configuredPassword: string | undefined,
  allowInvalidFallback = false,
): SeedPasswordSelection {
  if (!configuredPassword?.trim()) {
    return { password: generatePassword(), generated: true, invalidConfigured: false };
  }

  if (passwordSchema.safeParse(configuredPassword).success) {
    return { password: configuredPassword, generated: false, invalidConfigured: false };
  }

  if (!allowInvalidFallback) {
    throw new Error(PASSWORD_POLICY_ERROR);
  }

  return { password: generatePassword(), generated: true, invalidConfigured: true };
}
