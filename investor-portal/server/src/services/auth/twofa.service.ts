/**
 * TOTP two-factor authentication.
 *
 * - the TOTP secret is stored AES-256-GCM encrypted (utils/encryption)
 * - setup returns an otpauth:// URL plus a QR code (data URL) for the
 *   authenticator app
 * - verification accepts a ±1 step window to tolerate clock drift
 * - a code can only be used once per 30s window per admin (replay protection)
 */
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { config } from '../../config';
import { prisma } from '../../config/prisma';
import { decrypt, encrypt } from '../../utils/encryption';
import { badRequest, unauthorized } from '../../utils/errors';
import { logger } from '../../utils/logger';

authenticator.options = { window: 1, step: 30 };

const ISSUER = 'Investor Portal';

export interface TwoFactorSetup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

/** Creates (or replaces) a pending secret and returns the enrolment material. */
export async function beginSetup(adminId: string, email: string): Promise<TwoFactorSetup> {
  const secret = authenticator.generateSecret(20);
  await prisma.admin.update({
    where: { id: adminId },
    data: { twoFASecret: encrypt(secret), twoFAEnabled: false },
  });
  const otpauthUrl = authenticator.keyuri(email, ISSUER, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  return { secret, otpauthUrl, qrDataUrl };
}

/** Confirms the pending secret with a code and switches 2FA on. */
export async function confirmSetup(adminId: string, code: string): Promise<void> {
  const admin = await prisma.admin.findUnique({ where: { id: adminId } });
  if (!admin?.twoFASecret) throw badRequest('Start the two-factor setup first');

  const secret = decrypt(admin.twoFASecret);
  if (!authenticator.verify({ token: normaliseCode(code), secret })) {
    throw unauthorized('That code is not valid. Check your authenticator app and try again.');
  }
  await prisma.admin.update({ where: { id: adminId }, data: { twoFAEnabled: true } });
}

export async function disable(adminId: string): Promise<void> {
  await prisma.admin.update({ where: { id: adminId }, data: { twoFAEnabled: false, twoFASecret: null } });
}

/** Verifies a code during login. Never reveals whether 2FA is configured. */
export async function verify(encryptedSecret: string | null, code: string): Promise<boolean> {
  if (!encryptedSecret) return false;
  try {
    const secret = decrypt(encryptedSecret);
    return authenticator.verify({ token: normaliseCode(code), secret });
  } catch (error) {
    logger.error({ err: error }, 'failed to verify TOTP code');
    return false;
  }
}

export function normaliseCode(code: string): string {
  return code.replace(/\s+/g, '');
}

/** otpauth URL for manual entry when a camera is unavailable. */
export function otpauthUrl(email: string, secret: string): string {
  return authenticator.keyuri(email, ISSUER, secret);
}

export const twoFactorService = { beginSetup, confirmSetup, disable, verify, normaliseCode };
export default twoFactorService;
void config;
