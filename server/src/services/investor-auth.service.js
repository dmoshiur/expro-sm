/**
 * Investor self-service authentication.
 *
 * A completely separate system from admin auth (services/auth.service.js):
 * separate table (investor_sessions), separate cookie, separate lockout
 * counters on the investors row. An investor token can therefore never be
 * resolved by the admin middleware (and vice versa), even if leaked.
 *
 * Login id: the investor's mobile number OR their member code (INV-000123).
 * Passwords are always set by an admin first (temporary, must be changed at
 * first login) and can then be managed by the investor. There is deliberately
 * no public sign-up and no self-service password reset - the office resets
 * forgotten passwords after verifying identity in person / by phone, which
 * matches how this organisation already works.
 */
import { query, withTransaction } from '../db/client.js';
import { NOW } from '../db/sql.js';
import { config } from '../config/index.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { normalizeBdMobile } from '../utils/validate.js';
import { maskMobile } from '../utils/mask.js';
import {
  INVESTOR_PASSWORD_MIN_LENGTH,
  assertInvestorPasswordPolicy,
  generateSessionToken,
  generateTempPassword,
  hashPassword,
  hashToken,
  verifyPassword,
} from './crypto.service.js';
import * as audit from './audit.service.js';

// Anti-enumeration delay on failed logins (skipped under tests, where the
// lockout flow itself is what is being asserted).
const LOGIN_DELAY_MS = config.isTest ? 0 : 1_200;

const SESSION_CACHE_TTL_MS = 5_000;
const sessionCache = new Map(); // token_hash -> { value, expires }

export function clearInvestorSessionCache() {
  sessionCache.clear();
}

/** INV-000123 - mirrors the printf('%06d') backfill in migration 002. */
export function memberCodeForId(id) {
  return `INV-${String(id).padStart(6, '0')}`;
}

/** The investor shape the portal client is allowed to see about itself. */
export function publicPortalInvestor(row) {
  if (!row) return null;
  return {
    id: row.id,
    member_code: row.member_code ?? memberCodeForId(row.id),
    name: row.name,
    mobile: row.mobile,
    mobile_masked: maskMobile(row.mobile),
    email: row.email ?? null,
    status: row.status,
    must_change_password: Boolean(row.must_change_password),
    last_login_at: row.last_login_at ?? null,
    member_since: row.created_at ?? null,
    has_photo: Boolean(row.has_photo ?? row.photo),
  };
}

/** Normalises a login id to { mobile } or { memberCode } (or null). */
export function parseLoginId(loginId) {
  const raw = String(loginId ?? '').trim();
  if (!raw) return null;
  const mobile = normalizeBdMobile(raw);
  if (mobile) return { mobile };
  // Member code: INV-000123 (accept INV000123 and any case too).
  const squashed = raw.toUpperCase().replace(/[\s-]/g, '');
  if (/^INV\d{1,12}$/.test(squashed)) return { memberCode: memberCodeForId(Number(squashed.slice(3))) };
  return { memberCode: raw.toUpperCase() };
}

export async function findInvestorByLoginId(loginId, client = undefined) {
  const parsed = parseLoginId(loginId);
  if (!parsed) return null;
  const res = parsed.mobile
    ? await query('select * from investors where mobile = ?1 and deleted_at is null', [parsed.mobile], client)
    : await query('select * from investors where upper(member_code) = upper(?1) and deleted_at is null', [parsed.memberCode], client);
  return res.rows[0] ?? null;
}

async function getInvestorRow(id, client = undefined) {
  const res = await query('select * from investors where id = ?1', [id], client);
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Login / lockout
// ---------------------------------------------------------------------------
export async function login({ loginId, password }, req) {
  const genericError = unauthorized('Invalid mobile number / member code or password');
  const investor = await findInvestorByLoginId(loginId);

  if (!investor || !investor.password_hash) {
    // Burn comparable time so unknown/unset accounts are not obviously faster.
    await verifyPassword(String(password ?? ''), 'scrypt$16384$8$1$00$00');
    await audit.record({
      action: audit.AUDIT_ACTIONS.INVESTOR_LOGIN_FAILED,
      entity: 'investor',
      entityId: investor?.id ?? null,
      meta: { reason: investor ? 'NO_PORTAL_PASSWORD' : 'UNKNOWN_LOGIN_ID', loginId: String(loginId ?? '').slice(0, 40) },
      req,
    });
    await delay(LOGIN_DELAY_MS);
    throw genericError;
  }

  if (investor.locked_until && new Date(investor.locked_until) > new Date()) {
    await audit.record({
      action: audit.AUDIT_ACTIONS.INVESTOR_LOGIN_LOCKED,
      entity: 'investor',
      entityId: investor.id,
      meta: { lockedUntil: investor.locked_until },
      req,
    });
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked after repeated failed logins. Try again later or contact the office.');
  }

  const passwordOk = await verifyPassword(String(password ?? ''), investor.password_hash);
  if (!passwordOk) {
    const failures = investor.failed_login_count + 1;
    const lock = failures >= config.security.investorLockoutThreshold;
    const lockedUntil = lock ? new Date(Date.now() + config.security.investorLockoutMinutes * 60_000) : null;
    await query(
      `update investors set failed_login_count = ?2,
         locked_until = case when ?3 then ?4 else locked_until end,
         updated_at = ${NOW}
       where id = ?1`,
      [investor.id, lock ? 0 : failures, lock, lockedUntil],
    );
    await audit.record({
      action: lock ? audit.AUDIT_ACTIONS.INVESTOR_LOGIN_LOCKED : audit.AUDIT_ACTIONS.INVESTOR_LOGIN_FAILED,
      entity: 'investor',
      entityId: investor.id,
      meta: { failures, locked: lock },
      req,
    });
    await delay(LOGIN_DELAY_MS);
    if (lock) {
      throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Account locked for ${config.security.investorLockoutMinutes} minutes.`);
    }
    throw genericError;
  }

  // Password is correct from here on, so specific messages no longer leak
  // anything an attacker without the password could learn.
  if (!investor.portal_enabled) {
    await audit.record({
      action: audit.AUDIT_ACTIONS.INVESTOR_LOGIN_FAILED,
      entity: 'investor',
      entityId: investor.id,
      meta: { reason: 'PORTAL_DISABLED' },
      req,
    });
    throw forbidden('Portal access is disabled for this account. Please contact the office.');
  }
  if (investor.status !== 'ACTIVE') {
    await audit.record({
      action: audit.AUDIT_ACTIONS.INVESTOR_LOGIN_FAILED,
      entity: 'investor',
      entityId: investor.id,
      meta: { reason: 'NOT_ACTIVE', status: investor.status },
      req,
    });
    throw forbidden('This account is not active. Please contact the office.');
  }

  await query(
    `update investors set failed_login_count = 0, locked_until = null, last_login_at = ${NOW} where id = ?1`,
    [investor.id],
  );
  await audit.record({
    action: audit.AUDIT_ACTIONS.INVESTOR_LOGIN_SUCCESS,
    entity: 'investor',
    entityId: investor.id,
    meta: { memberCode: investor.member_code },
    req,
  });
  return { ...investor, password_hash: undefined, last_login_at: new Date() };
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export async function createInvestorSession(investor, req, client = undefined) {
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.security.investorSessionTtlHours * 3600_000);
  const res = await query(
    `insert into investor_sessions (investor_id, token_hash, expires_at, ip, user_agent)
     values (?1,?2,?3,?4,?5)
     returning id, expires_at`,
    [investor.id, tokenHash, expiresAt, req?.clientIp ?? null, String(req?.get?.('user-agent') ?? '').slice(0, 400) || null],
    client,
  );
  sessionCache.clear();
  return { token, sessionId: res.rows[0].id, expiresAt: res.rows[0].expires_at };
}

/**
 * Resolve an investor session token. The join re-checks that the investor is
 * still ACTIVE, not deleted and portal-enabled, so disabling access or
 * deactivating the investor takes effect immediately (plus the ≤5s cache).
 */
export async function resolveInvestorSession(token, req = null) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const tokenHash = hashToken(token);
  const cached = sessionCache.get(tokenHash);
  if (cached && cached.expires > Date.now()) {
    if (cached.value === null) return null;
    return { ...cached.value, cached: true };
  }

  const res = await query(
    `select s.id as session_id, s.investor_id, s.expires_at, s.revoked_at, s.refreshed_at,
            i.member_code, i.name, i.mobile, i.email, i.status, i.portal_enabled,
            i.must_change_password, i.last_login_at, i.created_at, i.deleted_at,
            (i.photo is not null) as has_photo
       from investor_sessions s
       join investors i on i.id = s.investor_id
      where s.token_hash = ?1`,
    [tokenHash],
  );
  const row = res.rows[0];
  if (
    !row ||
    row.revoked_at ||
    new Date(row.expires_at) <= new Date() ||
    row.deleted_at ||
    !row.portal_enabled ||
    row.status !== 'ACTIVE'
  ) {
    sessionCache.set(tokenHash, { value: null, expires: Date.now() + SESSION_CACHE_TTL_MS });
    return null;
  }

  void touchInvestorSession(row.session_id, req);
  const value = {
    token,
    tokenHash,
    sessionId: row.session_id,
    investor: {
      id: row.investor_id,
      member_code: row.member_code ?? memberCodeForId(row.investor_id),
      name: row.name,
      mobile: row.mobile,
      email: row.email,
      status: row.status,
      must_change_password: row.must_change_password,
      last_login_at: row.last_login_at,
      created_at: row.created_at,
      has_photo: row.has_photo,
    },
    expiresAt: row.expires_at,
    refreshedAt: row.refreshed_at,
  };
  sessionCache.set(tokenHash, { value, expires: Date.now() + SESSION_CACHE_TTL_MS });
  return value;
}

async function touchInvestorSession(sessionId, req) {
  try {
    await query(
      `update investor_sessions set last_seen_at = ${NOW},
         ip = coalesce(?2, ip),
         user_agent = coalesce(?3, user_agent)
       where id = ?1`,
      [sessionId, req?.clientIp ?? null, String(req?.get?.('user-agent') ?? '').slice(0, 400) || null],
    );
  } catch (err) {
    logger.warn('investor session touch failed', { err, sessionId });
  }
}

export function needsInvestorRotation(session) {
  const ageMs = Date.now() - new Date(session.refreshedAt).getTime();
  return ageMs > config.security.sessionRotateAfterMinutes * 60_000;
}

export async function rotateInvestorSession(session, req) {
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.security.investorSessionTtlHours * 3600_000);
  await withTransaction(async (client) => {
    const current = await query('select * from investor_sessions where id = ?1 ', [session.sessionId], client);
    const row = current.rows[0];
    if (!row || row.revoked_at) throw unauthorized('Session is no longer valid');
    await client.query(
      `insert into investor_sessions (investor_id, token_hash, expires_at, ip, user_agent, rotated_from)
       values (?1,?2,?3,?4,?5,?6) returning id`,
      [row.investor_id, tokenHash, expiresAt, req?.clientIp ?? null, String(req?.get?.('user-agent') ?? '').slice(0, 400) || null, row.id],
    );
    await client.query(
      `update investor_sessions set revoked_at = ${NOW}, revoked_reason = 'ROTATED',
         rotated_to = (select id from investor_sessions where token_hash = ?2)
       where id = ?1`,
      [row.id, tokenHash],
    );
  });
  sessionCache.clear();
  return { token, expiresAt };
}

export async function revokeInvestorSession(sessionId, reason = 'LOGOUT') {
  await query(`update investor_sessions set revoked_at = ${NOW}, revoked_reason = ?2 where id = ?1 and revoked_at is null`, [
    sessionId,
    reason,
  ]);
  sessionCache.clear();
}

export async function revokeAllInvestorSessions(investorId, { exceptSessionId = null, reason = 'REVOKED' } = {}, client = undefined) {
  await query(
    `update investor_sessions set revoked_at = ${NOW}, revoked_reason = ?3
      where investor_id = ?1 and revoked_at is null and (?2 is null or id <> ?2)`,
    [investorId, exceptSessionId, reason],
    client,
  );
  sessionCache.clear();
}

export async function listInvestorSessions(investorId, client = undefined) {
  const res = await query(
    `select id, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at, revoked_reason
       from investor_sessions where investor_id = ?1 order by created_at desc limit 25`,
    [investorId],
    client,
  );
  return res.rows;
}

export async function countActiveInvestorSessions(investorId, client = undefined) {
  const res = await query(
    `select count(*) as count from investor_sessions
      where investor_id = ?1 and revoked_at is null and expires_at > ${NOW}`,
    [investorId],
    client,
  );
  return Number(res.rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Password change (investor self-service)
// ---------------------------------------------------------------------------
export async function changeOwnPassword(investorId, { currentPassword, newPassword }, req) {
  const investor = await getInvestorRow(investorId);
  if (!investor) throw notFound('Investor not found');
  const ok = await verifyPassword(String(currentPassword ?? ''), investor.password_hash);
  if (!ok) throw unauthorized('Current password is incorrect');
  if (await verifyPassword(String(newPassword ?? ''), investor.password_hash)) {
    throw badRequest('New password must be different from the current password');
  }
  assertInvestorPasswordPolicy(newPassword, {
    mobile: investor.mobile,
    memberCode: investor.member_code,
    name: investor.name,
  });
  const passwordHash = await hashPassword(newPassword, undefined, { minLength: INVESTOR_PASSWORD_MIN_LENGTH });
  await query(
    `update investors set password_hash = ?2, password_changed_at = ${NOW}, must_change_password = false,
       failed_login_count = 0, locked_until = null where id = ?1`,
    [investorId, passwordHash],
  );
  sessionCache.clear();
  await audit.record({
    action: audit.AUDIT_ACTIONS.INVESTOR_PASSWORD_CHANGED,
    entity: 'investor',
    entityId: investorId,
    meta: { self: true },
    req,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Admin-side portal access management
// ---------------------------------------------------------------------------
export async function getPortalAccess(investorId, client = undefined) {
  const res = await query(
    `select id, member_code, name, mobile, status, portal_enabled,
            (password_hash is not null) as has_password, must_change_password,
            password_changed_at, failed_login_count, locked_until, last_login_at, deleted_at
       from investors where id = ?1`,
    [investorId],
    client,
  );
  const row = res.rows[0];
  if (!row) throw notFound('Investor not found');
  const activeSessions = await countActiveInvestorSessions(investorId, client);
  return {
    investor_id: row.id,
    member_code: row.member_code ?? memberCodeForId(row.id),
    name: row.name,
    mobile: row.mobile,
    status: row.status,
    deleted: Boolean(row.deleted_at),
    portal_enabled: Boolean(row.portal_enabled),
    has_password: Boolean(row.has_password),
    must_change_password: Boolean(row.must_change_password),
    password_changed_at: row.password_changed_at,
    failed_login_count: row.failed_login_count,
    locked_until: row.locked_until,
    last_login_at: row.last_login_at,
    active_sessions: activeSessions,
    login_url: `${config.publicBaseUrl}/portal/login`,
  };
}

/**
 * Admin sets (or resets) the investor's portal password and enables access.
 * Without an explicit password a readable temporary one is generated. Either
 * way the password is temporary: the investor must change it at first login,
 * and all existing portal sessions are revoked. The plaintext is returned
 * exactly once (to hand over / SMS) and never stored or audited.
 */
export async function setPortalPasswordByAdmin(investorId, { password = null } = {}, actor, req) {
  const investor = await getInvestorRow(investorId);
  if (!investor) throw notFound('Investor not found');
  if (investor.deleted_at) throw badRequest('Investor is deleted; restore it before enabling portal access');

  const generated = !password;
  const tempPassword = generated ? generateTempPassword() : String(password);
  assertInvestorPasswordPolicy(tempPassword, {
    mobile: investor.mobile,
    memberCode: investor.member_code,
    name: investor.name,
  });
  const passwordHash = await hashPassword(tempPassword, undefined, { minLength: INVESTOR_PASSWORD_MIN_LENGTH });

  await withTransaction(async (client) => {
    await query(
      `update investors set password_hash = ?2, portal_enabled = true, must_change_password = true,
         password_changed_at = ${NOW}, failed_login_count = 0, locked_until = null, updated_at = ${NOW}
       where id = ?1`,
      [investorId, passwordHash],
      client,
    );
    await client.query(
      `update investor_sessions set revoked_at = ${NOW}, revoked_reason = 'PASSWORD_RESET' where investor_id = ?1 and revoked_at is null`,
      [investorId],
    );
  });
  sessionCache.clear();

  await audit.record({
    action: audit.AUDIT_ACTIONS.INVESTOR_PASSWORD_SET,
    entity: 'investor',
    entityId: investorId,
    meta: { generated, mustChange: true },
    actor,
    req,
  });
  return { tempPassword, generated, portal: await getPortalAccess(investorId) };
}

/** Enable / disable portal access. Disabling revokes all live sessions. */
export async function setPortalEnabled(investorId, enabled, actor, req) {
  const investor = await getInvestorRow(investorId);
  if (!investor) throw notFound('Investor not found');
  if (enabled && !investor.password_hash) {
    throw badRequest('Set a portal password first - enabling access without a password would lock the investor out');
  }
  await withTransaction(async (client) => {
    await query(`update investors set portal_enabled = ?2, updated_at = ${NOW} where id = ?1`, [investorId, Boolean(enabled)], client);
    if (!enabled) {
      await client.query(
        `update investor_sessions set revoked_at = ${NOW}, revoked_reason = 'PORTAL_DISABLED' where investor_id = ?1 and revoked_at is null`,
        [investorId],
      );
    }
  });
  sessionCache.clear();
  await audit.record({
    action: enabled ? audit.AUDIT_ACTIONS.INVESTOR_PORTAL_ENABLED : audit.AUDIT_ACTIONS.INVESTOR_PORTAL_DISABLED,
    entity: 'investor',
    entityId: investorId,
    oldValue: { portal_enabled: Boolean(investor.portal_enabled) },
    newValue: { portal_enabled: Boolean(enabled) },
    actor,
    req,
  });
  return getPortalAccess(investorId);
}

export async function revokePortalSessionsByAdmin(investorId, actor, req) {
  const investor = await getInvestorRow(investorId);
  if (!investor) throw notFound('Investor not found');
  await revokeAllInvestorSessions(investorId, { reason: 'ADMIN_REVOKED' });
  await audit.record({
    action: audit.AUDIT_ACTIONS.INVESTOR_SESSIONS_REVOKED,
    entity: 'investor',
    entityId: investorId,
    meta: { scope: 'ALL' },
    actor,
    req,
  });
  return getPortalAccess(investorId);
}

/**
 * SMS the freshly set credentials to the investor. The sms_logs body preview
 * is replaced with a redacted one so the temporary password is never stored
 * (the audit trail records only that an SMS of this type was sent).
 */
export async function sendPortalCredentialsSms({ investor, tempPassword, actor = null, req = null }) {
  const { sendRaw } = await import('./sms.service.js');
  const { renderTemplate } = await import('./sms/templates.js');
  const loginUrl = `${config.publicBaseUrl}/portal/login`;
  const message = renderTemplate('PORTAL_CREDENTIALS', {
    name: investor.name,
    memberCode: investor.member_code ?? memberCodeForId(investor.id),
    mobile: investor.mobile,
    password: tempPassword,
    url: loginUrl,
  });
  return sendRaw({
    mobile: investor.mobile,
    message,
    bodyPreview: 'Portal login credentials sent (password redacted)',
    messageType: 'MANUAL',
    templateKey: 'PORTAL_CREDENTIALS',
    investorId: investor.id,
    adminId: actor?.id ?? null,
    req,
  });
}
