import { Validator, LIMITS } from '../utils/validate.js';
import { ok } from '../utils/http.js';
import { badRequest } from '../utils/errors.js';
import * as authService from '../services/auth.service.js';
import * as audit from '../services/audit.service.js';
import { setSessionCookie, clearSessionCookie } from '../middleware/auth.js';

/** POST /api/auth/login  { email, password, totpCode? } */
export async function login(req, res) {
  const v = new Validator(req.body);
  v.email('email', { required: true });
  v.string('password', { required: true, max: LIMITS.password.max, label: 'Password' });
  v.string('totpCode', { required: false, max: 10, label: '2FA code' });
  const input = v.result();

  const admin = await authService.login({ email: input.email, password: input.password, totpCode: input.totpCode }, req);
  const session = await authService.createSession(admin, req);
  setSessionCookie(res, session.token);

  return ok(res, {
    admin: {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      totp_enabled: admin.totp_enabled,
      must_change_password: admin.must_change_password,
    },
    expiresAt: session.expiresAt,
  });
}

/** POST /api/auth/logout */
export async function logout(req, res) {
  if (req.session) {
    await authService.revokeSession(req.session.sessionId, 'LOGOUT');
    await audit.record({
      action: audit.AUDIT_ACTIONS.LOGOUT,
      entity: 'admin',
      entityId: req.admin?.id ?? null,
      actor: req.admin,
      req,
    });
  }
  clearSessionCookie(res);
  return ok(res, { loggedOut: true });
}

/** GET /api/auth/me */
export async function me(req, res) {
  const sessions = await authService.listSessions(req.admin.id);
  return ok(res, {
    admin: req.admin,
    session: { expiresAt: req.session?.expiresAt ?? null },
    sessions: sessions.slice(0, 10),
  });
}

/** POST /api/auth/refresh - explicit rotation (also happens transparently). */
export async function refresh(req, res) {
  const rotated = await authService.rotateSession(req.session, req);
  setSessionCookie(res, rotated.token);
  await audit.record({
    action: audit.AUDIT_ACTIONS.SESSION_REFRESHED,
    entity: 'admin',
    entityId: req.admin.id,
    actor: req.admin,
    req,
  });
  const admin = await authService.getAdminById(req.admin.id);
  return ok(res, { admin, expiresAt: rotated.expiresAt });
}

/** POST /api/auth/change-password */
export async function changePassword(req, res) {
  const v = new Validator(req.body);
  v.string('currentPassword', { required: true, max: LIMITS.password.max, label: 'Current password' });
  v.string('newPassword', { required: true, min: LIMITS.password.min, max: LIMITS.password.max, label: 'New password' });
  const input = v.result();
  await authService.changeOwnPassword(req.admin.id, input, req);
  // Keep this session, drop the others.
  await authService.revokeAllSessionsForAdmin(req.admin.id, { exceptSessionId: req.session.sessionId });
  return ok(res, { changed: true });
}

// --- 2FA -------------------------------------------------------------------
export async function totpStatus(req, res) {
  const admin = await authService.getAdminById(req.admin.id);
  return ok(res, { totp_enabled: admin.totp_enabled, confirmedAt: admin.totp_confirmed_at });
}

/** POST /api/auth/totp/setup - returns secret + otpauth URI for manual entry. */
export async function totpSetup(req, res) {
  const data = await authService.startTotpSetup(req.admin.id, req);
  return ok(res, data);
}

/** POST /api/auth/totp/confirm { code } */
export async function totpConfirm(req, res) {
  const v = new Validator(req.body);
  v.string('code', { required: true, max: 10, label: '6-digit code' });
  const { code } = v.result();
  const result = await authService.confirmTotpSetup(req.admin.id, code, req);
  return ok(res, result);
}

/** POST /api/auth/totp/disable { password, code } */
export async function totpDisable(req, res) {
  const v = new Validator(req.body);
  v.string('password', { required: true, max: LIMITS.password.max, label: 'Password' });
  v.string('code', { required: true, max: 10, label: '6-digit code' });
  const input = v.result();
  const result = await authService.disableTotp(req.admin.id, input, req);
  return ok(res, result);
}

/** POST /api/auth/sessions/revoke-all */
export async function revokeOtherSessions(req, res) {
  await authService.revokeAllSessionsForAdmin(req.admin.id, { exceptSessionId: req.session.sessionId });
  await audit.record({
    action: audit.AUDIT_ACTIONS.SESSION_REVOKED,
    entity: 'admin',
    entityId: req.admin.id,
    meta: { scope: 'OTHERS' },
    actor: req.admin,
    req,
  });
  return ok(res, { revoked: true });
}

export function requireSession(req) {
  if (!req.session) throw badRequest('No active session');
  return req.session;
}
