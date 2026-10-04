/**
 * Housekeeping - runs daily at 02:30 Asia/Dhaka.
 *
 * 1. Expired payment links lose their token hash, so a leaked link can never be
 *    used once its validity window has passed (defence in depth on top of the
 *    expiry check in the payment service).
 * 2. SMS logs older than SMS_LOG_RETENTION_DAYS are deleted (the audit trail of
 *    who sent what stays in audit_logs; the message bodies are personal data and
 *    should not live forever).
 * 3. Refresh tokens that are expired or revoked beyond their retention window
 *    are pruned so the table does not grow without bound.
 */
import { prisma } from '../config/prisma';
import { jobLogger } from '../utils/logger';
import type { JobContext, JobResult } from './scheduler';

const SMS_LOG_RETENTION_DAYS = Number(process.env.SMS_LOG_RETENTION_DAYS ?? 180);
const REFRESH_TOKEN_RETENTION_DAYS = 30;

export async function tokenCleanupJob(context: JobContext): Promise<JobResult> {
  const log = context.logger ?? jobLogger('token-cleanup');
  const now = new Date();

  const expiredLinks = await prisma.installment.updateMany({
    where: { tokenExpiresAt: { lt: now }, payTokenHash: { not: null } },
    data: { payTokenHash: null },
  });

  const smsCutoff = new Date(now.getTime() - SMS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const smsLogs = await prisma.smsLog.deleteMany({ where: { createdAt: { lt: smsCutoff } } });

  const tokenCutoff = new Date(now.getTime() - REFRESH_TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const refreshTokens = await prisma.refreshToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: tokenCutoff } }, { revokedAt: { lt: tokenCutoff } }],
    },
  });

  const metrics = {
    expiredPaymentLinks: expiredLinks.count,
    smsLogsPruned: smsLogs.count,
    refreshTokensPruned: refreshTokens.count,
  };
  log.info(metrics, 'housekeeping finished');

  return {
    summary: `expired ${metrics.expiredPaymentLinks} link(s), pruned ${metrics.smsLogsPruned} SMS log(s)`,
    metrics,
  };
}

export default tokenCleanupJob;
