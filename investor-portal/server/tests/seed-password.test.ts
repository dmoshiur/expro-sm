import { describe, expect, it } from 'vitest';
import { passwordSchema } from '../src/validators/auth.validator';
import { resolveSeedPassword } from '../src/utils/seed-password';

describe('first super-admin password selection', () => {
  it('uses a configured password that satisfies the policy', () => {
    const selection = resolveSeedPassword('BootstrapPassword123!');

    expect(selection).toEqual({
      password: 'BootstrapPassword123!',
      generated: false,
      invalidConfigured: false,
    });
  });

  it('generates a password when the setting is unset or blank', () => {
    for (const configuredPassword of [undefined, '', '   ']) {
      const selection = resolveSeedPassword(configuredPassword);

      expect(selection.generated).toBe(true);
      expect(selection.invalidConfigured).toBe(false);
      expect(passwordSchema.safeParse(selection.password).success).toBe(true);
      expect(selection.password).toHaveLength(45);
    }
  });

  it('replaces an invalid configured password on Vercel Production', () => {
    const selection = resolveSeedPassword('short', true);

    expect(selection.generated).toBe(true);
    expect(selection.invalidConfigured).toBe(true);
    expect(selection.password).not.toBe('short');
    expect(passwordSchema.safeParse(selection.password).success).toBe(true);
  });

  it('still rejects an invalid configured password outside Vercel Production', () => {
    expect(() => resolveSeedPassword('short')).toThrow(/SEED_SUPER_ADMIN_PASSWORD must be 10-200 characters/);
  });
});
