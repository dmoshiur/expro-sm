/**
 * Authentication: email + password + TOTP 2FA, server-side sessions with
 * rotation, lockout on repeated failures, admin (user) management.
 *
 * Session model: the browser gets an opaque 256-bit token in an
 * httpOnly / Secure / SameSite=Strict cookie. Only SHA-256(token) is stored.
 */
import { query, withTransaction } from '../db/pool.js';
import { config } from '../config/index.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import {
  assertPasswordPolicy,
  decryptField,
  encryptField,
  generateSessionToken,
  generateTotpSecret,
  groupSecret,
  hashPassword,
  hashToken,
  sha256Hex,
  totpUri,
  verifyPassword,
  verifyTotp,
} from './crypto.service.js';
import * as audit from './audit.service.js';

/** Subset helper used for audit old/new payloads. */
const pick = (row, keys) => Object.fromEntries(keys.filter((key) => row && key in row).map((key) => [key, row[key]]));

export const ROLES = ['SUPER_ADMIN', 'ACCOUNTANT', 'VIEWER'];
export const ROLE_RANK = { VIEWER: 1, ACCOUNTANT: 2, SUPER_ADMIN: 3 };

const PUBLIC_ADMIN_COLUMNS = `id, name, email, role, totp_enabled, is_active, must_change_password,
  failed_login_count, locked_until, last_login_at, totp_confirmed_at, disabled_reason, created_at, updated_at`;

const SESSION_CACHE_TTL_MS = 5_000;
const sessionCache = new Map(); // token_hash -> { session, expires }

export function clearSessionCache() {
  sessionCache.clear();
}

// ---------------------------------------------------------------------------
// Admins / users
// ---------------------------------------------------------------------------
export async function findAdminByEmail(email, client = undefined) {
  const res = await query('select * from admins where lower(email) = lower($1)', [email], client);
  return res.rows[0] ?? null;
}

export async function getAdminById(id, client = undefined) {
  const res = await query(`select ${PUBLIC_ADMIN_COLUMNS} from admins where id = $1`, [id], client);
  return res.rows[0] ?? null;
}

export async function listAdmins({ search, role, isActive, limit = 50, offset = 0 } = {}, client = undefined) {
  const where = [];
  const params = [];
  const push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (search) {
    const term = `%${String(search).toLowerCase()}%`;
    where.push(`(lower(name) like ${push(term)} or lower(email) like $${params.length})`);
  }
  if (role) where.push(`role = ${push(role)}`);
  if (isActive !== undefined) where.push(`is_active = ${push(isActive)}`);
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const rows = await query(
    `select ${PUBLIC_ADMIN_COLUMNS} from admins ${whereSql} order by created_at asc limit ${push(limit)} offset ${push(offset)}`,
    params,
    client,
  );
  const total = await query(`select count(*)::int as count from admins ${whereSql}`, params.slice(0, params.length - 2), client);
  return { rows: rows.rows, total: total.rows[0].count, limit, offset };
}

export async function createAdmin({ name, email, password, role }, actor, req) {
  if (!ROLES.includes(role)) throw badRequest('Invalid role');
  assertPasswordPolicy(password, { email, name });
  const existing = await findAdminByEmail(email);
  if (existing) throw conflict('An admin with this email already exists');
  const passwordHash = await hashPassword(password);
  const res = await query(
    `insert into admins (name, email, password_hash, role)
     values ($1, lower($2), $3, $4)
     returning ${PUBLIC_ADMIN_COLUMNS}`,
    [name, email, passwordHash, role],
  );
  const admin = res.rows[0];
  await audit.record(
    { action: audit.AUDIT_ACTIONS.ADMIN_CREATED, entity: 'admin', entityId: admin.id, newValue: admin, actor, req },
  );
  return admin;
}

/** Partial update of an admin. Role changes and disabling are audited distinctly. */
export async function updateAdmin(id, changes, actor, req) {
  return withTransaction(async (client) => {
    const before = await query('select * from admins where id = $1 for update', [id], client);
    const current = before.rows[0];
    if (!current) throw notFound('Admin not found');

    const sets = [];
    // $1 is reserved for the id in the WHERE clause; SET params start at $2.
    const params = [id];
    const push = (v) => {
      params.push(v);
      return `$${params.length}`;
    };

    if (changes.name !== undefined) sets.push(`name = ${push(changes.name)}`);
    if (changes.email !== undefined) sets.push(`email = lower(${push(changes.email)})`);
    if (changes.role !== undefined) {
      if (!ROLES.includes(changes.role)) throw badRequest('Invalid role');
      if (current.role === 'SUPER_ADMIN' && changes.role !== 'SUPER_ADMIN') {
        const others = await query(
          `select count(*)::int as count from admins where role = 'SUPER_ADMIN' and is_active and id <> $1`,
          [id],
          client,
        );
        if (others.rows[0].count === 0) throw conflict('At least one active Super Admin must remain');
      }
      sets.push(`role = ${push(changes.role)}`);
    }
    if (changes.is_active !== undefined) {
      if (current.role === 'SUPER_ADMIN' && changes.is_active === false) {
        const others = await query(
          `select count(*)::int as count from admins where role = 'SUPER_ADMIN' and is_active and id <> $1`,
          [id],
          client,
        );
        if (others.rows[0].count === 0) throw conflict('At least one active Super Admin must remain');
      }
      if (changes.is_active === false && actor?.id === id) throw conflict('You cannot disable your own account');
      sets.push(`is_active = ${push(changes.is_active)}`);
      sets.push(`disabled_reason = ${push(changes.is_active ? null : changes.disabled_reason || 'Disabled by administrator')}`);
      if (changes.is_active === false) {
        await client.query(
          `update sessions set revoked_at = now(), revoked_reason = 'ADMIN_DISABLED' where admin_id = $1 and revoked_at is null`,
          [id],
        );
      }
    }
    if (sets.length === 0) return { ...current, ...changes };

    const res = await query(
      `update admins set ${sets.join(', ')} where id = $1 returning ${PUBLIC_ADMIN_COLUMNS}`,
      params,
      client,
    );
    const updated = res.rows[0];

    if (changes.role !== undefined && changes.role !== current.role) {
      await audit.record(
        {
          action: audit.AUDIT_ACTIONS.ADMIN_ROLE_CHANGED,
          entity: 'admin',
          entityId: id,
          oldValue: { role: current.role },
          newValue: { role: changes.role },
          actor,
          req,
        },
        client,
      );
    }
    if (changes.is_active !== undefined && changes.is_active !== current.is_active) {
      await audit.record(
        {
          action: changes.is_active ? audit.AUDIT_ACTIONS.ADMIN_ENABLED : audit.AUDIT_ACTIONS.ADMIN_DISABLED,
          entity: 'admin',
          entityId: id,
          oldValue: { is_active: current.is_active },
          newValue: { is_active: changes.is_active, reason: changes.disabled_reason ?? null },
          actor,
          req,
        },
        client,
      );
    }
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.ADMIN_UPDATED,
        entity: 'admin',
        entityId: id,
        oldValue: pick(current, ['name', 'email', 'role', 'is_active']),
        newValue: pick(updated, ['name', 'email', 'role', 'is_active']),
        actor,
        req,
      },
      client,
    );
    return updated;
  });
}

/** Super Admin resets another admin's password; all their sessions are revoked. */
export async function resetAdminPassword(id, { newPassword, mustChange = true }, actor, req) {
  const target = await getAdminById(id);
  if (!target) throw notFound('Admin not found');
  assertPasswordPolicy(newPassword, { email: target.email, name: target.name });
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await query(
      `update admins set password_hash = $2, password_changed_at = now(), failed_login_count = 0,
        locked_until = null, must_change_password = $3 where id = $1`,
      [id, passwordHash, mustChange],
      client,
    );
    await client.query(`update sessions set revoked_at = now(), revoked_reason = 'PASSWORD_RESET' where admin_id = $1 and revoked_at is null`, [id]);
  });
  await audit.record({
    action: audit.AUDIT_ACTIONS.PASSWORD_RESET,
    entity: 'admin',
    entityId: id,
    meta: { mustChange, bySelf: actor?.id === id },
    actor,
    req,
  });
  return target;
}

/** Super Admin resets (disables) another admin's 2FA so they can re-enrol. */
export async function resetAdminTotp(id, actor, req) {
  const target = await getAdminById(id);
  if (!target) throw notFound('Admin not found');
  await query(
    `update admins set totp_secret = null, totp_enabled = false, totp_last_step = null, totp_confirmed_at = null where id = $1`,
    [id],
  );
  await audit.record({
    action: audit.AUDIT_ACTIONS.TOTP_DISABLED,
    entity: 'admin',
    entityId: id,
    meta: { resetBySuperAdmin: true },
    actor,
    req,
  });
  return target;
}

async function loadTotpSecret(adminId, client = undefined) {
  const res = await query('select totp_secret from admins where id = $1', [adminId], client);
  const enc = res.rows[0]?.totp_secret;
  if (!enc) return null;
  return decryptField(enc, { aad: `admin:${adminId}:totp` });
}

// ---------------------------------------------------------------------------
// Login / lockout
// ---------------------------------------------------------------------------
const LOCKOUT_BASE_DELAY_MS = 1_500;

export async function login({ email, password, totpCode }, req) {
  const admin = await findAdminByEmail(email);
  const genericError = unauthorized('Invalid email or password');

  if (!admin) {
    // Burn comparable time so unknown emails are not obviously faster.
    await verifyPassword(String(password ?? ''), 'scrypt$16384$8$1$00$00');
    await audit.record({
      action: audit.AUDIT_ACTIONS.LOGIN_FAILED,
      entity: 'admin',
      entityId: null,
      meta: { email: String(email ?? '').slice(0, 254), reason: 'UNKNOWN_EMAIL' },
      req,
    });
    await delay(LOCKOUT_BASE_DELAY_MS);
    throw genericError;
  }

  if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
    await audit.record({
      action: audit.AUDIT_ACTIONS.LOGIN_LOCKED,
      entity: 'admin',
      entityId: admin.id,
      meta: { lockedUntil: admin.locked_until },
      req,
    });
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked after repeated failed logins. Try again later.');
  }

  if (!admin.is_active) {
    await audit.record({
      action: audit.AUDIT_ACTIONS.LOGIN_FAILED,
      entity: 'admin',
      entityId: admin.id,
      meta: { reason: 'DISABLED' },
      req,
    });
    throw forbidden('This account is disabled');
  }

  const passwordOk = await verifyPassword(String(password ?? ''), admin.password_hash);
  if (!passwordOk) {
    const failures = admin.failed_login_count + 1;
    const threshold = config.security.lockoutThreshold;
    const lock = failures >= threshold;
    await query(
      `update admins set failed_login_count = $2,
         locked_until = case when $3 then now() + ($4 || ' minutes')::interval else locked_until end
       where id = $1`,
      [admin.id, lock ? 0 : failures, lock, String(config.security.lockoutMinutes)],
    );
    await audit.record({
      action: lock ? audit.AUDIT_ACTIONS.LOGIN_LOCKED : audit.AUDIT_ACTIONS.LOGIN_FAILED,
      entity: 'admin',
      entityId: admin.id,
      meta: { failures, locked: lock },
      req,
    });
    await delay(LOCKOUT_BASE_DELAY_MS);
    if (lock) {
      throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Account locked for ${config.security.lockoutMinutes} minutes.`);
    }
    throw genericError;
  }

  // 2FA required?
  if (admin.totp_enabled) {
    const code = String(totpCode ?? '').trim();
    if (!code) throw new AppError(401, 'TOTP_REQUIRED', 'Enter the 6-digit code from your authenticator app', { totpRequired: true });
    const secret = await loadTotpSecret(admin.id);
    const check = await verifyTotp(secret, code, { lastStep: admin.totp_last_step });
    if (!check.ok) {
      await query('update admins set failed_login_count = failed_login_count + 1 where id = $1', [admin.id]);
      await audit.record({
        action: audit.AUDIT_ACTIONS.TOTP_VERIFY_FAILED,
        entity: 'admin',
        entityId: admin.id,
        meta: { replayed: Boolean(check.replayed) },
        req,
      });
      throw unauthorized('Invalid or already used 2FA code');
    }
    await query('update admins set totp_last_step = $2 where id = $1', [admin.id, check.step]);
  }

  await query(
    'update admins set failed_login_count = 0, locked_until = null, last_login_at = now() where id = $1',
    [admin.id],
  );
  await audit.record({ action: audit.AUDIT_ACTIONS.LOGIN_SUCCESS, entity: 'admin', entityId: admin.id, req });
  return { ...admin, password_hash: undefined, totp_secret: undefined };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export const REFRESH_GRACE_MS = 60_000;

export async function createSession(admin, req, client = undefined) {
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.security.sessionTtlHours * 3600_000);
  const res = await query(
    `insert into sessions (admin_id, token_hash, expires_at, ip, user_agent)
     values ($1,$2,$3,$4,$5)
     returning id, expires_at`,
    [admin.id, tokenHash, expiresAt, req?.clientIp ?? null, String(req?.get?.('user-agent') ?? '').slice(0, 400) || null],
    client,
  );
  sessionCache.clear();
  return { token, sessionId: res.rows[0].id, expiresAt: res.rows[0].expires_at };
}

/**
 * Resolve a session token to { admin, session }. Rotates the token when it is
 * older than SESSION_ROTATE_AFTER_MINUTES (transparent to the caller).
 */
export async function resolveSession(token, req = null) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const tokenHash = hashToken(token);
  const cached = sessionCache.get(tokenHash);
  if (cached && cached.expires > Date.now()) {
    if (cached.value === null) return null;
    return { ...cached.value, cached: true };
  }

  const res = await query(
    `select s.id as session_id, s.admin_id, s.expires_at, s.revoked_at, s.refreshed_at, s.ip, s.user_agent,
            a.name, a.email, a.role, a.is_active, a.totp_enabled, a.must_change_password
       from sessions s
       join admins a on a.id = s.admin_id
      where s.token_hash = $1`,
    [tokenHash],
  );
  const row = res.rows[0];
  if (!row || row.revoked_at || new Date(row.expires_at) <= new Date() || !row.is_active) {
    sessionCache.set(tokenHash, { value: null, expires: Date.now() + SESSION_CACHE_TTL_MS });
    return null;
  }

  void touchSession(row.session_id, req);
  const value = {
    token,
    tokenHash,
    sessionId: row.session_id,
    admin: {
      id: row.admin_id,
      name: row.name,
      email: row.email,
      role: row.role,
      totp_enabled: row.totp_enabled,
      must_change_password: row.must_change_password,
    },
    expiresAt: row.expires_at,
    refreshedAt: row.refreshed_at,
  };
  sessionCache.set(tokenHash, { value, expires: Date.now() + SESSION_CACHE_TTL_MS });
  return value;
}

async function touchSession(sessionId, req) {
  try {
    await query(
      `update sessions set last_seen_at = now(),
         ip = coalesce($2, ip),
         user_agent = coalesce($3, user_agent)
       where id = $1`,
      [sessionId, req?.clientIp ?? null, String(req?.get?.('user-agent') ?? '').slice(0, 400) || null],
    );
  } catch (err) {
    logger.warn('session touch failed', { err, sessionId });
  }
}

/** Decide whether a session is old enough to require token rotation. */
export function needsRotation(session) {
  const ageMs = Date.now() - new Date(session.refreshedAt).getTime();
  return ageMs > config.security.sessionRotateAfterMinutes * 60_000;
}

/**
 * Rotate: issue a new token, revoke the old one, keep the lineage. Used by
 * POST /api/auth/refresh and transparently by the auth middleware.
 */
export async function rotateSession(session, req) {
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.security.sessionTtlHours * 3600_000);
  await withTransaction(async (client) => {
    const current = await query('select * from sessions where id = $1 for update', [session.sessionId], client);
    const row = current.rows[0];
    if (!row || row.revoked_at) throw unauthorized('Session is no longer valid');
    await client.query(
      `insert into sessions (admin_id, token_hash, expires_at, ip, user_agent, rotated_from)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [row.admin_id, tokenHash, expiresAt, req?.clientIp ?? null, String(req?.get?.('user-agent') ?? '').slice(0, 400) || null, row.id],
    );
    await client.query(
      `update sessions set revoked_at = now(), revoked_reason = 'ROTATED',
         rotated_to = (select id from sessions where token_hash = $2)
       where id = $1`,
      [row.id, tokenHash],
    );
  });
  sessionCache.clear();
  return { token, expiresAt };
}

export async function revokeSession(sessionId, reason = 'LOGOUT') {
  await query(`update sessions set revoked_at = now(), revoked_reason = $2 where id = $1 and revoked_at is null`, [
    sessionId,
    reason,
  ]);
  sessionCache.clear();
}

export async function revokeAllSessionsForAdmin(adminId, { exceptSessionId = null } = {}) {
  await query(
    `update sessions set revoked_at = now(), revoked_reason = 'REVOKED'
      where admin_id = $1 and revoked_at is null and ($2::uuid is null or id <> $2::uuid)`,
    [adminId, exceptSessionId],
  );
  sessionCache.clear();
}

export async function listSessions(adminId, client = undefined) {
  const res = await query(
    `select id, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at, revoked_reason
       from sessions where admin_id = $1 order by created_at desc limit 25`,
    [adminId],
    client,
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Password change (self-service)
// ---------------------------------------------------------------------------
export async function changeOwnPassword(adminId, { currentPassword, newPassword }, req) {
  const res = await query('select * from admins where id = $1', [adminId]);
  const admin = res.rows[0];
  if (!admin) throw notFound('Admin not found');
  const ok = await verifyPassword(String(currentPassword ?? ''), admin.password_hash);
  if (!ok) throw unauthorized('Current password is incorrect');
  if (await verifyPassword(String(newPassword ?? ''), admin.password_hash)) {
    throw badRequest('New password must be different from the current password');
  }
  assertPasswordPolicy(newPassword, { email: admin.email, name: admin.name });
  const passwordHash = await hashPassword(newPassword);
  await query(
    `update admins set password_hash = $2, password_changed_at = now(), must_change_password = false,
       failed_login_count = 0, locked_until = null where id = $1`,
    [adminId, passwordHash],
  );
  await audit.record({ action: audit.AUDIT_ACTIONS.PASSWORD_CHANGED, entity: 'admin', entityId: adminId, actor: admin, req });
  return true;
}

// ---------------------------------------------------------------------------
// TOTP enrolment
// ---------------------------------------------------------------------------
export async function startTotpSetup(adminId, req) {
  const admin = await getAdminById(adminId);
  if (!admin) throw notFound('Admin not found');
  if (admin.totp_enabled) throw conflict('2FA is already enabled. Disable it first to re-enrol.');
  const secret = generateTotpSecret();
  await query('update admins set totp_secret = $2, totp_enabled = false, totp_last_step = null where id = $1', [
    adminId,
    encryptField(secret, { aad: `admin:${adminId}:totp` }),
  ]);
  await audit.record({ action: audit.AUDIT_ACTIONS.TOTP_SETUP_STARTED, entity: 'admin', entityId: adminId, req });
  return {
    secret,
    secretGrouped: groupSecret(secret),
    otpauthUri: totpUri(secret, { account: admin.email }),
    issuer: config.totp.issuer,
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  };
}

/** Confirms enrolment with a live code; only then is 2FA actually enabled. */
export async function confirmTotpSetup(adminId, code, req) {
  const admin = await getAdminById(adminId);
  if (!admin) throw notFound('Admin not found');
  const secret = await loadTotpSecret(adminId);
  if (!secret) throw badRequest('Start the 2FA setup first');
  const check = await verifyTotp(secret, code);
  if (!check.ok) {
    await audit.record({ action: audit.AUDIT_ACTIONS.TOTP_VERIFY_FAILED, entity: 'admin', entityId: adminId, meta: { stage: 'setup' }, req });
    throw badRequest('That code is not valid. Check your device clock and try again.');
  }
  await query(
    'update admins set totp_enabled = true, totp_last_step = $2, totp_confirmed_at = now() where id = $1',
    [adminId, check.step],
  );
  await audit.record({ action: audit.AUDIT_ACTIONS.TOTP_ENABLED, entity: 'admin', entityId: adminId, req });
  return { totp_enabled: true };
}

/** Disabling 2FA requires the current password + a valid code. */
export async function disableTotp(adminId, { password, code }, req) {
  const res = await query('select * from admins where id = $1', [adminId]);
  const admin = res.rows[0];
  if (!admin) throw notFound('Admin not found');
  if (!admin.totp_enabled) return { totp_enabled: false };
  const ok = await verifyPassword(String(password ?? ''), admin.password_hash);
  if (!ok) throw unauthorized('Password is incorrect');
  const secret = await loadTotpSecret(adminId);
  const check = await verifyTotp(secret, code, { lastStep: admin.totp_last_step });
  if (!check.ok) throw unauthorized('Invalid 2FA code');
  await query('update admins set totp_secret = null, totp_enabled = false, totp_last_step = null where id = $1', [adminId]);
  await audit.record({ action: audit.AUDIT_ACTIONS.TOTP_DISABLED, entity: 'admin', entityId: adminId, meta: { bySelf: true }, req });
  return { totp_enabled: false };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
export async function countAdmins(client = undefined) {
  const res = await query('select count(*)::int as count from admins', [], client);
  return res.rows[0].count;
}

/** Creates the first SUPER_ADMIN when the table is empty (used by seed.js). */
export async function ensureFirstSuperAdmin({ name, email, password }, req = null) {
  const existing = await countAdmins();
  if (existing > 0) return { created: false };
  assertPasswordPolicy(password, { email, name });
  const passwordHash = await hashPassword(password);
  const res = await query(
    `insert into admins (name, email, password_hash, role, must_change_password)
     values ($1, lower($2), $3, 'SUPER_ADMIN', true)
     returning ${PUBLIC_ADMIN_COLUMNS}`,
    [name, email, passwordHash],
  );
  await audit.record({
    action: audit.AUDIT_ACTIONS.ADMIN_CREATED,
    entity: 'admin',
    entityId: res.rows[0].id,
    newValue: { email: res.rows[0].email, role: 'SUPER_ADMIN', bootstrap: true },
    req,
  });
  return { created: true, admin: res.rows[0] };
}

export { sha256Hex };
