import { Validator, LIMITS } from '../utils/validate.js';
import { ok, created } from '../utils/http.js';
import { badRequest, notFound } from '../utils/errors.js';
import { parsePagination, paged } from '../utils/pagination.js';
import * as authService from '../services/auth.service.js';

export async function list(req, res) {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 });
  const { role, search } = req.query;
  const isActive = req.query.isActive === undefined ? undefined : String(req.query.isActive) === 'true';
  const result = await authService.listAdmins({ search, role, isActive, limit, offset });
  return ok(res, paged(result));
}

export async function detail(req, res) {
  const admin = await authService.getAdminById(Number(req.params.id));
  if (!admin) throw notFound('Admin not found');
  const sessions = await authService.listSessions(admin.id);
  return ok(res, { admin, sessions });
}

export async function create(req, res) {
  const v = new Validator(req.body);
  v.string('name', { required: true, max: LIMITS.name, label: 'Name' });
  v.email('email', { required: true });
  v.string('password', { required: true, min: LIMITS.password.min, max: LIMITS.password.max, label: 'Password' });
  v.oneOf('role', authService.ROLES, { required: true, label: 'Role' });
  const input = v.result();
  const admin = await authService.createAdmin(input, req.admin, req);
  return created(res, { admin });
}

export async function update(req, res) {
  const id = Number(req.params.id);
  const v = new Validator(req.body);
  v.string('name', { required: false, max: LIMITS.name, label: 'Name' });
  v.email('email', { required: false });
  v.oneOf('role', authService.ROLES, { required: false, label: 'Role' });
  v.bool('is_active', { required: false, label: 'Active flag' });
  v.string('disabled_reason', { required: false, max: 300, label: 'Reason' });
  const changes = v.result();
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to update');
  const admin = await authService.updateAdmin(id, changes, req.admin, req);
  return ok(res, { admin });
}

export async function resetPassword(req, res) {
  const v = new Validator(req.body);
  v.string('newPassword', { required: true, min: LIMITS.password.min, max: LIMITS.password.max, label: 'New password' });
  v.bool('mustChange', { required: false, label: 'Force change' });
  const { newPassword, mustChange = true } = v.result();
  await authService.resetAdminPassword(Number(req.params.id), { newPassword, mustChange }, req.admin, req);
  return ok(res, { reset: true });
}

export async function resetTotp(req, res) {
  await authService.resetAdminTotp(Number(req.params.id), req.admin, req);
  return ok(res, { totp_reset: true });
}

export async function revokeSessions(req, res) {
  await authService.revokeAllSessionsForAdmin(Number(req.params.id));
  return ok(res, { revoked: true });
}
