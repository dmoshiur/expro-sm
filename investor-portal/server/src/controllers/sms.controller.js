import { Validator, LIMITS } from '../utils/validate.js';
import { ok } from '../utils/http.js';
import { badRequest } from '../utils/errors.js';
import { parsePagination, paged } from '../utils/pagination.js';
import { config } from '../config/index.js';
import * as smsService from '../services/sms.service.js';

export async function list(req, res) {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
  const result = await smsService.listSmsLogs({
    installmentId: req.query.installmentId ? Number(req.query.installmentId) : undefined,
    investorId: req.query.investorId ? Number(req.query.investorId) : undefined,
    messageType: req.query.messageType,
    providerStatus: req.query.providerStatus,
    from: req.query.from,
    to: req.query.to,
    limit,
    offset,
  });
  return ok(res, paged({ rows: result.rows, total: result.total, limit, offset }));
}

export async function providerInfo(_req, res) {
  return ok(res, {
    provider: config.sms.provider,
    dryRun: config.sms.dryRun,
    senderIdConfigured: Boolean(config.sms.senderId),
    apiUrlConfigured: Boolean(config.sms.apiUrl),
  });
}

/** POST /sms/test { mobile, message? } - Super Admin only, rate limited. */
export async function sendTest(req, res) {
  const v = new Validator(req.body ?? {});
  v.mobile('mobile', { required: true, label: 'Mobile number' });
  v.string('message', { required: false, max: LIMITS.reason, label: 'Message' });
  const input = v.result();
  const result = await smsService.sendRaw({
    mobile: input.mobile,
    message: input.message || `Test message from ${config.totp.issuer} (Asia/Dhaka).`,
    messageType: 'TEST',
    templateKey: 'TEST',
    adminId: req.admin.id,
    req,
  });
  if (!result.ok) throw badRequest(result.error || 'SMS provider rejected the message');
  return ok(res, { sent: true, provider: config.sms.provider });
}
