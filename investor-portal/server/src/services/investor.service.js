/**
 * Investors, nominees and their protected files.
 *
 * Security notes
 *  - NID numbers are stored AES-256-GCM encrypted plus an HMAC blind index used
 *    for exact search and duplicate detection (nid_hash, unique per investor).
 *  - NID scans are stored encrypted and are readable by SUPER_ADMIN only, and
 *    every read is audited.
 *  - VIEWER role gets masked PII (see utils/mask.js).
 *  - No hard delete: investors are deactivated / soft-deleted.
 */
import { query, withTransaction } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../utils/errors.js';
import { maskInvestor, maskMobile, maskNominee, firstNameOnly } from '../utils/mask.js';
import { decryptField, encryptField, last4, nidHash } from './crypto.service.js';
import { encryptScan, decryptScan, validateUpload } from './files.service.js';
import * as audit from './audit.service.js';

export const INVESTOR_STATUSES = ['ACTIVE', 'INACTIVE', 'CLOSED'];
const SORTABLE = ['created_at', 'updated_at', 'name', 'status', 'mobile'];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function listInvestors(filters = {}, client = undefined) {
  const where = ['i.deleted_at is null'];
  const params = [];
  const push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (filters.includeDeleted) where[0] = 'true';
  if (filters.search) {
    const term = `%${String(filters.search).toLowerCase().trim()}%`;
    where.push(`(i.search_text like ${push(term)} or i.name ilike $${params.length})`);
  }
  if (filters.status) where.push(`i.status = ${push(filters.status)}`);
  if (filters.hasNominees === true) where.push('exists (select 1 from nominees n where n.investor_id = i.id)');
  if (filters.hasNominees === false) where.push('not exists (select 1 from nominees n where n.investor_id = i.id)');

  const sortColumn = SORTABLE.includes(filters.sort) ? filters.sort : 'created_at';
  const dir = String(filters.dir).toLowerCase() === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(Number(filters.limit) || 25, 100);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const whereSql = `where ${where.join(' and ')}`;

  const rows = await query(
    `select i.id, i.name, i.mobile, i.address, i.status, i.nid_last4, (i.nid_encrypted is not null) as has_nid,
            (i.photo is not null) as has_photo, (i.nid_scan is not null) as has_nid_scan,
            i.created_at, i.updated_at, i.deleted_at,
            (select count(*)::int from nominees n where n.investor_id = i.id) as nominee_count,
            (select count(*)::int from investments v where v.investor_id = i.id) as investment_count,
            (select coalesce(sum(v.total_amount), 0)::bigint from investments v
              where v.investor_id = i.id and v.status <> 'CANCELLED') as total_invested,
            (select coalesce(sum(inst.amount_paid), 0)::bigint from installments inst
               join investments v2 on v2.id = inst.investment_id
              where v2.investor_id = i.id) as total_collected
       from investors i
       ${whereSql}
       order by i.${sortColumn} ${dir}, i.id desc
       limit ${push(limit)} offset ${push(offset)}`,
    params,
    client,
  );
  const totalRes = await query(
    `select count(*)::int as count from investors i ${whereSql}`,
    params.slice(0, params.length - 2),
    client,
  );
  return { rows: rows.rows, total: totalRes.rows[0].count, limit, offset };
}

export async function getInvestor(id, client = undefined) {
  const res = await query(
    `select i.*, (i.photo is not null) as has_photo, (i.nid_scan is not null) as has_nid_scan
       from investors i where i.id = $1`,
    [id],
    client,
  );
  if (!res.rows[0]) throw notFound('Investor not found');
  return res.rows[0];
}

export async function getInvestorDetail(id, client = undefined) {
  const investor = await getInvestor(id, client);
  const nominees = await listNominees(id, client);
  return { ...investor, nominees };
}

export async function listNominees(investorId, client = undefined) {
  const res = await query(
    `select id, investor_id, name, relation, mobile, nid_last4, (nid_encrypted is not null) as has_nid,
            share_percent, created_at, updated_at
       from nominees where investor_id = $1 order by share_percent desc, id asc`,
    [investorId],
    client,
  );
  return res.rows;
}

export async function findByNid(nid, client = undefined) {
  const hash = nidHash(nid);
  const res = await query('select id, name, mobile, status from investors where nid_hash = $1 and deleted_at is null', [hash], client);
  return res.rows[0] ?? null;
}

/** Minimal payload for investor-facing pages: first name only. */
export async function getPublicInvestorName(investorId, client = undefined) {
  const res = await query('select name from investors where id = $1', [investorId], client);
  return firstNameOnly(res.rows[0]?.name);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
export async function createInvestor(data, actor, req) {
  const { name, mobile, nid, address, notes, status = 'ACTIVE', nominees = null } = data;
  return withTransaction(async (client) => {
    const dupe = await query('select id from investors where mobile = $1 and deleted_at is null', [mobile], client);
    if (dupe.rows[0]) throw conflict('An investor with this mobile number already exists');

    let nidHashed = null;
    let nidEncrypted = null;
    let nidLast4 = null;
    if (nid) {
      nidHashed = nidHash(nid);
      const existing = await query('select id from investors where nid_hash = $1 and deleted_at is null', [nidHashed], client);
      if (existing.rows[0]) throw conflict('An investor with this NID already exists', { investorId: existing.rows[0].id });
      nidEncrypted = encryptField(nid, { aad: 'investor:nid' });
      nidLast4 = last4(nid);
    }

    const res = await query(
      `insert into investors (name, mobile, nid_encrypted, nid_hash, nid_last4, address, notes, status, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning *`,
      [name, mobile, nidEncrypted, nidHashed, nidLast4, address ?? null, notes ?? null, status, actor?.id ?? null],
      client,
    );
    const investor = res.rows[0];

    if (nominees && nominees.length > 0) {
      await insertNominees(client, investor.id, nominees);
    }

    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.INVESTOR_CREATED,
        entity: 'investor',
        entityId: investor.id,
        newValue: publicInvestor(investor),
        meta: { nomineeCount: nominees?.length ?? 0 },
        actor,
        req,
      },
      client,
    );
    return { ...investor, nominees: await listNominees(investor.id, client) };
  });
}

export async function updateInvestor(id, changes, actor, req) {
  return withTransaction(async (client) => {
    const current = await query('select * from investors where id = $1 for update', [id], client);
    const before = current.rows[0];
    if (!before) throw notFound('Investor not found');
    if (before.deleted_at) throw badRequest('Investor is deleted; restore it before editing');

    const sets = [];
    // $1 is the row id in the WHERE clause; SET params start at $2.
    const params = [id];
    const push = (v) => {
      params.push(v);
      return `$${params.length}`;
    };

    for (const field of ['name', 'address', 'notes', 'status']) {
      if (changes[field] !== undefined) sets.push(`${field} = ${push(changes[field])}`);
    }
    if (changes.mobile !== undefined && changes.mobile !== before.mobile) {
      const dupe = await query('select id from investors where mobile = $1 and id <> $2 and deleted_at is null', [changes.mobile, id], client);
      if (dupe.rows[0]) throw conflict('Another investor already uses this mobile number');
      sets.push(`mobile = ${push(changes.mobile)}`);
    }
    if (changes.nid !== undefined) {
      const nid = changes.nid;
      if (nid === null || nid === '') {
        sets.push('nid_encrypted = null');
        sets.push('nid_hash = null');
        sets.push('nid_last4 = null');
      } else {
        const hash = nidHash(nid);
        const dupe = await query('select id from investors where nid_hash = $1 and id <> $2', [hash, id], client);
        if (dupe.rows[0]) throw conflict('Another investor already uses this NID');
        sets.push(`nid_encrypted = ${push(encryptField(nid, { aad: 'investor:nid' }))}`);
        sets.push(`nid_hash = ${push(hash)}`);
        sets.push(`nid_last4 = ${push(last4(nid))}`);
      }
    }
    if (sets.length === 0) return { ...before, nominees: await listNominees(id, client) };
    sets.push(`updated_by = ${push(actor?.id ?? null)}`);

    const res = await query(`update investors set ${sets.join(', ')} where id = $1 returning *`, params, client);
    const after = res.rows[0];
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.INVESTOR_UPDATED,
        entity: 'investor',
        entityId: id,
        oldValue: publicInvestor(before),
        newValue: publicInvestor(after),
        actor,
        req,
      },
      client,
    );
    return { ...after, nominees: await listNominees(id, client) };
  });
}

/** Activate / deactivate / close (soft state changes, always audited). */
export async function setInvestorStatus(id, status, { reason } = {}, actor, req) {
  if (!INVESTOR_STATUSES.includes(status)) throw badRequest('Invalid status');
  return withTransaction(async (client) => {
    const current = await query('select * from investors where id = $1 for update', [id], client);
    const before = current.rows[0];
    if (!before) throw notFound('Investor not found');
    const res = await query(
      'update investors set status = $2, updated_by = $3 where id = $1 returning *',
      [id, status, actor?.id ?? null],
      client,
    );
    await audit.record(
      {
        action: status === 'ACTIVE' ? audit.AUDIT_ACTIONS.INVESTOR_RESTORED : audit.AUDIT_ACTIONS.INVESTOR_DEACTIVATED,
        entity: 'investor',
        entityId: id,
        oldValue: { status: before.status },
        newValue: { status, reason: reason ?? null },
        actor,
        req,
      },
      client,
    );
    return res.rows[0];
  });
}

/** Soft delete. Investments are kept for the record (no financial data loss). */
export async function softDeleteInvestor(id, { reason }, actor, req) {
  return withTransaction(async (client) => {
    const current = await query('select * from investors where id = $1 for update', [id], client);
    const before = current.rows[0];
    if (!before) throw notFound('Investor not found');
    if (before.deleted_at) return before;
    const outstanding = await query(
      `select count(*)::int as count from installments inst
         join investments v on v.id = inst.investment_id
        where v.investor_id = $1 and inst.status in ('PENDING', 'PARTIALLY_PAID', 'OVERDUE')`,
      [id],
      client,
    );
    const res = await query('update investors set deleted_at = now(), status = \'INACTIVE\', updated_by = $2 where id = $1 returning *', [
      id,
      actor?.id ?? null,
    ], client);
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.INVESTOR_DELETED,
        entity: 'investor',
        entityId: id,
        oldValue: { deleted_at: null, status: before.status },
        newValue: { deleted_at: new Date().toISOString(), status: 'INACTIVE' },
        meta: { reason: reason ?? null, outstandingInstallments: outstanding.rows[0].count },
        actor,
        req,
      },
      client,
    );
    return res.rows[0];
  });
}

export async function restoreInvestor(id, actor, req) {
  return withTransaction(async (client) => {
    const res = await query('update investors set deleted_at = null, status = \'ACTIVE\', updated_by = $2 where id = $1 returning *', [
      id,
      actor?.id ?? null,
    ], client);
    if (!res.rows[0]) throw notFound('Investor not found');
    await audit.record({
      action: audit.AUDIT_ACTIONS.INVESTOR_RESTORED,
      entity: 'investor',
      entityId: id,
      newValue: { deleted_at: null, status: 'ACTIVE' },
      actor,
      req,
    }, client);
    return res.rows[0];
  });
}

// ---------------------------------------------------------------------------
// Nominees (max 3, shares must total 100 - also enforced by DB triggers)
// ---------------------------------------------------------------------------
async function insertNominees(client, investorId, nominees) {
  if (nominees.length > 3) throw badRequest('An investor can have at most 3 nominees');
  const total = nominees.reduce((sum, n) => sum + Number(n.share_percent ?? 0), 0);
  if (Math.abs(total - 100) > 0.001) {
    throw badRequest(`Nominee shares must total 100% (currently ${total}%)`, { total });
  }
  for (const n of nominees) {
    await query(
      `insert into nominees (investor_id, name, relation, mobile, nid_encrypted, nid_hash, nid_last4, share_percent)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        investorId,
        n.name,
        n.relation,
        n.mobile,
        n.nid ? encryptField(n.nid, { aad: `investor:${investorId}:nominee_nid` }) : null,
        n.nid ? nidHash(n.nid) : null,
        n.nid ? last4(n.nid) : null,
        n.share_percent,
      ],
      client,
    );
  }
}

/** Replaces the whole nominee set atomically (SUPER_ADMIN only, audited). */
export async function replaceNominees(investorId, nominees, actor, req) {
  return withTransaction(async (client) => {
    const investor = await query('select id, name from investors where id = $1 for update', [investorId], client);
    if (!investor.rows[0]) throw notFound('Investor not found');
    const before = await listNominees(investorId, client);

    await query('delete from nominees where investor_id = $1', [investorId], client);
    if (nominees.length > 0) await insertNominees(client, investorId, nominees);

    const after = await listNominees(investorId, client);
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.NOMINEES_REPLACED,
        entity: 'investor',
        entityId: investorId,
        oldValue: before.map(nomineeAuditShape),
        newValue: after.map(nomineeAuditShape),
        actor,
        req,
      },
      client,
    );
    return after;
  });
}

export async function updateNominee(investorId, nomineeId, changes, actor, req) {
  return withTransaction(async (client) => {
    const current = await query('select * from nominees where id = $1 and investor_id = $2 for update', [nomineeId, investorId], client);
    const before = current.rows[0];
    if (!before) throw notFound('Nominee not found');
    const sets = [];
    // $1 is the row id in the WHERE clause; SET params start at $2.
    const params = [id];
    const push = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    for (const field of ['name', 'relation', 'mobile']) {
      if (changes[field] !== undefined) sets.push(`${field} = ${push(changes[field])}`);
    }
    if (changes.share_percent !== undefined) sets.push(`share_percent = ${push(changes.share_percent)}`);
    if (changes.nid !== undefined) {
      sets.push(`nid_encrypted = ${push(changes.nid ? encryptField(changes.nid, { aad: `investor:${investorId}:nominee_nid` }) : null)}`);
      sets.push(`nid_hash = ${push(changes.nid ? nidHash(changes.nid) : null)}`);
      sets.push(`nid_last4 = ${push(changes.nid ? last4(changes.nid) : null)}`);
    }
    if (sets.length === 0) return before;
    const res = await query(`update nominees set ${sets.join(', ')} where id = $1 returning *`, [...params, nomineeId], client);
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.NOMINEE_UPDATED,
        entity: 'nominee',
        entityId: nomineeId,
        oldValue: nomineeAuditShape(before),
        newValue: nomineeAuditShape(res.rows[0]),
        meta: { investorId },
        actor,
        req,
      },
      client,
    );
    return res.rows[0];
  });
}

function nomineeAuditShape(n) {
  return {
    id: n.id,
    name: n.name,
    relation: n.relation,
    mobile_masked: maskMobile(n.mobile),
    share_percent: n.share_percent,
    has_nid: Boolean(n.nid_last4),
  };
}

// ---------------------------------------------------------------------------
// Protected fields (NID value / scan)
// ---------------------------------------------------------------------------
export async function revealNid(investorId, actor, req) {
  const investor = await getInvestor(investorId);
  if (!investor.nid_encrypted) throw notFound('No NID on file for this investor');
  const nid = decryptField(investor.nid_encrypted, { aad: 'investor:nid' });
  await audit.record({
    action: audit.AUDIT_ACTIONS.INVESTOR_NID_VIEWED,
    entity: 'investor',
    entityId: investorId,
    meta: { nid_last4: investor.nid_last4 },
    actor,
    req,
  });
  return { nid, nid_last4: investor.nid_last4 };
}

export async function revealNomineeNid(investorId, nomineeId, actor, req) {
  const nominees = await listNominees(investorId);
  const nominee = nominees.find((n) => Number(n.id) === Number(nomineeId));
  if (!nominee) throw notFound('Nominee not found');
  const res = await query('select nid_encrypted from nominees where id = $1', [nomineeId]);
  if (!res.rows[0]?.nid_encrypted) throw notFound('No NID on file for this nominee');
  const nid = decryptField(res.rows[0].nid_encrypted, { aad: `investor:${investorId}:nominee_nid` });
  await audit.record({
    action: audit.AUDIT_ACTIONS.INVESTOR_NID_VIEWED,
    entity: 'nominee',
    entityId: nomineeId,
    meta: { investorId },
    actor,
    req,
  });
  return { nid, nid_last4: nominee.nid_last4 };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
export async function setPhoto(investorId, buffer, actor, req) {
  const file = validateUpload(buffer, { kind: 'photo' });
  const res = await query(
    `update investors set photo = $2, photo_mime = $3, photo_size = $4, updated_by = $5
      where id = $1 and deleted_at is null returning id`,
    [investorId, file.buffer, file.mime, file.size, actor?.id ?? null],
  );
  if (!res.rows[0]) throw notFound('Investor not found');
  await audit.record({
    action: audit.AUDIT_ACTIONS.INVESTOR_PHOTO_UPDATED,
    entity: 'investor',
    entityId: investorId,
    newValue: { mime: file.mime, size: file.size },
    actor,
    req,
  });
  return { mime: file.mime, size: file.size };
}

export async function getPhoto(investorId) {
  const res = await query('select photo, photo_mime, photo_size from investors where id = $1', [investorId]);
  const row = res.rows[0];
  if (!row) throw notFound('Investor not found');
  if (!row.photo) throw notFound('No photo uploaded for this investor');
  return { buffer: row.photo, mime: row.photo_mime || 'image/jpeg', size: row.photo_size };
}

export async function setNidScan(investorId, buffer, actor, req) {
  const file = validateUpload(buffer, { kind: 'scan' });
  const encrypted = encryptScan(file.buffer, investorId);
  const res = await query(
    `update investors set nid_scan = $2, nid_scan_mime = $3, nid_scan_size = $4, updated_by = $5
      where id = $1 and deleted_at is null returning id`,
    [investorId, encrypted, file.mime, file.size, actor?.id ?? null],
  );
  if (!res.rows[0]) throw notFound('Investor not found');
  await audit.record({
    action: audit.AUDIT_ACTIONS.INVESTOR_NID_UPDATED,
    entity: 'investor',
    entityId: investorId,
    newValue: { mime: file.mime, size: file.size, encrypted: true },
    actor,
    req,
  });
  return { mime: file.mime, size: file.size };
}

export async function getNidScan(investorId, actor, req) {
  const res = await query('select nid_scan, nid_scan_mime, nid_scan_size from investors where id = $1', [investorId]);
  const row = res.rows[0];
  if (!row) throw notFound('Investor not found');
  if (!row.nid_scan) throw notFound('No NID scan uploaded for this investor');
  const buffer = decryptScan(row.nid_scan, investorId);
  await audit.record({
    action: audit.AUDIT_ACTIONS.INVESTOR_NID_VIEWED,
    entity: 'investor',
    entityId: investorId,
    meta: { kind: 'scan' },
    actor,
    req,
  });
  return { buffer, mime: row.nid_scan_mime || 'image/jpeg' };
}

// ---------------------------------------------------------------------------
// Presentation (role aware masking)
// ---------------------------------------------------------------------------
export function publicInvestor(row) {
  if (!row) return null;
  const { nid_encrypted, nid_hash, photo, nid_scan, ...rest } = row;
  return rest;
}

export function presentInvestor(row, role) {
  const base = publicInvestor(row);
  if (!base) return null;
  if (role === 'VIEWER') return maskInvestor(base);
  return { ...base, mobile_masked: maskMobile(base.mobile) };
}

export function presentNominees(nominees, role) {
  if (role === 'VIEWER') return nominees.map(maskNominee);
  return nominees.map((n) => ({ ...n, mobile_masked: maskMobile(n.mobile) }));
}
