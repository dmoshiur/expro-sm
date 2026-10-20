/**
 * Investor document slots: photo, NID front, NID back and signature (plus a
 * photo per nominee).
 *
 * Bytes never live in a public folder:
 *   PHOTO      -> investors.photo        (served through a permission-checked route)
 *   NID_FRONT  -> investors.nid_scan     (AES-256-GCM, Super Admin only)
 *   NID_BACK   -> investor_documents.data (AES-256-GCM)
 *   SIGNATURE  -> investor_documents.data (AES-256-GCM)
 *   NOMINEE_PHOTO -> investor_documents.data (AES-256-GCM)
 *
 * Every upload resets the slot to PENDING so staff must re-verify a replaced
 * document. A Super Admin then marks it VERIFIED or REJECTED with an optional
 * note that the investor sees on their profile.
 */
import { query, withTransaction } from '../db/client.js';
import { NOW } from '../db/sql.js';
import { badRequest, notFound } from '../utils/errors.js';
import { encryptBuffer, decryptBuffer } from './crypto.service.js';
import { validateUpload } from './files.service.js';
import * as audit from './audit.service.js';

export const DOCUMENT_KINDS = ['PHOTO', 'NID_FRONT', 'NID_BACK', 'SIGNATURE'];
export const NOMINEE_DOCUMENT_KINDS = ['NOMINEE_PHOTO'];
export const ALL_DOCUMENT_KINDS = [...DOCUMENT_KINDS, ...NOMINEE_DOCUMENT_KINDS];
export const REVIEW_STATUSES = ['VERIFIED', 'REJECTED'];

export const DOCUMENT_LABELS = {
  PHOTO: 'Photo',
  NID_FRONT: 'NID front',
  NID_BACK: 'NID back',
  SIGNATURE: 'Signature',
  NOMINEE_PHOTO: 'Nominee photo',
};

const LEGACY_COLUMN = { PHOTO: 'photo', NID_FRONT: 'nid_scan' };

function assertKind(kind) {
  if (!ALL_DOCUMENT_KINDS.includes(kind)) {
    throw badRequest(`Unknown document kind. Use one of: ${ALL_DOCUMENT_KINDS.join(', ')}`);
  }
}

function aadFor(investorId, kind, nomineeId = null) {
  return kind === 'NOMINEE_PHOTO'
    ? `investor:${investorId}:nominee:${nomineeId}:photo`
    : `investor:${investorId}:document:${kind}`;
}

async function findInvestor(investorId, client) {
  const res = await query(
    `select id, name, member_code, photo, photo_mime, photo_size, nid_scan, nid_scan_mime, nid_scan_size,
            deleted_at, frozen_at
       from investors where id = ?1`,
    [investorId],
    client,
  );
  if (!res.rows[0]) throw notFound('Investor not found');
  return res.rows[0];
}

async function findNominee(investorId, nomineeId, client) {
  const res = await query(
    'select id, name, investor_id from nominees where id = ?1 and investor_id = ?2',
    [nomineeId, investorId],
    client,
  );
  if (!res.rows[0]) throw notFound('Nominee not found');
  return res.rows[0];
}

async function findDocumentRow(investorId, kind, nomineeId = null, client = undefined) {
  const res = nomineeId
    ? await query(
        'select * from investor_documents where investor_id = ?1 and kind = ?2 and nominee_id = ?3',
        [investorId, kind, nomineeId],
        client,
      )
    : await query(
        'select * from investor_documents where investor_id = ?1 and kind = ?2 and nominee_id is null',
        [investorId, kind],
        client,
      );
  return res.rows[0] ?? null;
}

/**
 * Inserts or updates the document row for an upload. Always resets the review
 * state to PENDING and clears the previous reviewer/notes.
 */
async function upsertUploadedDocument(client, { investorId, kind, nomineeId = null, mime, size, data, uploadedBy }) {
  const existing = await findDocumentRow(investorId, kind, nomineeId, client);
  if (existing) {
    await query(
      `update investor_documents
          set status = 'PENDING', mime = ?2, size = ?3, data = ?4, uploaded_by = ?5, uploaded_at = ${NOW},
              reviewed_by = null, reviewed_at = null, review_note = null
        where id = ?1`,
      [existing.id, mime, size, data, uploadedBy],
      client,
    );
    return existing.id;
  }
  const res = await query(
    `insert into investor_documents (investor_id, nominee_id, kind, status, mime, size, data, uploaded_by, uploaded_at)
     values (?1, ?2, ?3, 'PENDING', ?4, ?5, ?6, ?7, ${NOW}) returning id`,
    [investorId, nomineeId, kind, mime, size, data, uploadedBy],
    client,
  );
  return res.rows[0].id;
}

/**
 * Upload / replace one document slot.
 * @param {object} options { actor, req, nomineeId = null, selfService = false }
 */
export async function uploadDocument(investorId, kind, buffer, { actor = null, req = null, nomineeId = null, selfService = false } = {}) {
  assertKind(kind);
  const nomineeDoc = kind === 'NOMINEE_PHOTO';
  if (nomineeDoc && !nomineeId) throw badRequest('Nominee id is required for a nominee photo');
  if (!nomineeDoc && nomineeId) throw badRequest('Nominee id is only valid for a nominee photo');

  const imageOnly = kind === 'PHOTO' || kind === 'SIGNATURE' || kind === 'NOMINEE_PHOTO';
  const file = validateUpload(buffer, { kind: imageOnly ? 'photo' : 'scan' });

  return withTransaction(async (client) => {
    const investor = await findInvestor(investorId, client);
    if (investor.deleted_at) throw badRequest('Investor is deleted; restore it first');
    if (nomineeDoc) await findNominee(investorId, nomineeId, client);

    let storedData = null;
    if (kind === 'PHOTO') {
      await query(
        `update investors set photo = ?2, photo_mime = ?3, photo_size = ?4, updated_by = ?5
          where id = ?1 and deleted_at is null`,
        [investorId, file.buffer, file.mime, file.size, actor?.id ?? null],
        client,
      );
    } else if (kind === 'NID_FRONT') {
      const encrypted = Buffer.from(encryptNidScan(file.buffer, investorId), 'utf8');
      await query(
        `update investors set nid_scan = ?2, nid_scan_mime = ?3, nid_scan_size = ?4, updated_by = ?5
          where id = ?1 and deleted_at is null`,
        [investorId, encrypted, file.mime, file.size, actor?.id ?? null],
        client,
      );
    } else {
      const ciphertext = encryptBuffer(file.buffer, { aad: aadFor(investorId, kind, nomineeId) });
      storedData = Buffer.from(ciphertext, 'utf8');
    }

    const documentId = await upsertUploadedDocument(client, {
      investorId,
      kind,
      nomineeId,
      mime: file.mime,
      size: file.size,
      data: storedData,
      uploadedBy: selfService ? 'INVESTOR' : 'ADMIN',
    });

    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.INVESTOR_DOCUMENT_UPLOADED,
        entity: 'investor_document',
        entityId: documentId,
        newValue: { kind, mime: file.mime, size: file.size, encrypted: kind !== 'PHOTO' },
        meta: { investorId, nomineeId, self: Boolean(selfService) },
        actor,
        req,
      },
      client,
    );

    return {
      kind,
      label: DOCUMENT_LABELS[kind],
      status: 'PENDING',
      mime: file.mime,
      size: file.size,
      nominee_id: nomineeId ?? null,
    };
  });
}

/**
 * NID scans use the existing per-investor AAD so files uploaded before this
 * migration stay readable. Kept local to avoid a circular import with
 * investor.service.js.
 */
function encryptNidScan(buffer, investorId) {
  return encryptBuffer(buffer, { aad: `investor:${investorId}:nid_scan` });
}

/** Binary read for one document slot (permission checks happen in the controller). */
export async function getDocumentFile(investorId, kind, { actor = null, req = null, nomineeId = null, selfService = false } = {}) {
  assertKind(kind);
  const nomineeDoc = kind === 'NOMINEE_PHOTO';
  if (nomineeDoc && !nomineeId) throw badRequest('Nominee id is required for a nominee photo');

  const investor = await findInvestor(investorId);
  if (nomineeDoc) await findNominee(investorId, nomineeId);

  let file;
  if (kind === 'PHOTO') {
    if (!investor.photo) throw notFound('No photo uploaded for this investor');
    file = { buffer: investor.photo, mime: investor.photo_mime || 'image/jpeg' };
  } else if (kind === 'NID_FRONT') {
    if (!investor.nid_scan) throw notFound('No NID front image uploaded for this investor');
    file = { buffer: decryptBuffer(investor.nid_scan, { aad: `investor:${investorId}:nid_scan` }), mime: investor.nid_scan_mime || 'image/jpeg' };
  } else {
    const row = await findDocumentRow(investorId, kind, nomineeId);
    if (!row || !row.data) throw notFound(`No ${DOCUMENT_LABELS[kind].toLowerCase()} uploaded for this investor`);
    file = { buffer: decryptBuffer(row.data, { aad: aadFor(investorId, kind, nomineeId) }), mime: row.mime || 'image/jpeg' };
  }

  if (kind !== 'PHOTO') {
    await audit.record({
      action: kind === 'NID_FRONT' || kind === 'NID_BACK' ? audit.AUDIT_ACTIONS.INVESTOR_NID_VIEWED : audit.AUDIT_ACTIONS.INVESTOR_DOCUMENT_VIEWED,
      entity: 'investor_document',
      entityId: `${investorId}:${kind}`,
      meta: { investorId, nomineeId, kind, self: Boolean(selfService) },
      actor,
      req,
    });
  }
  return file;
}

/** Slot state for the investor profile (admin + portal share this shape). */
export function buildDocumentSlots(investor, rows) {
  const byKey = new Map();
  for (const row of rows) {
    if (row.nominee_id) continue;
    byKey.set(row.kind, row);
  }
  return DOCUMENT_KINDS.map((kind) => {
    const row = byKey.get(kind);
    const hasFile =
      kind === 'PHOTO' ? Boolean(investor.photo || investor.has_photo) : kind === 'NID_FRONT' ? Boolean(investor.nid_scan || investor.has_nid_scan) : Boolean(row?.data);
    return {
      kind,
      label: DOCUMENT_LABELS[kind],
      has_file: hasFile,
      status: hasFile ? row?.status ?? 'PENDING' : 'MISSING',
      mime: row?.mime ?? (kind === 'PHOTO' ? investor.photo_mime : kind === 'NID_FRONT' ? investor.nid_scan_mime : null) ?? null,
      size: row?.size ?? (kind === 'PHOTO' ? investor.photo_size : kind === 'NID_FRONT' ? investor.nid_scan_size : null) ?? null,
      uploaded_at: row?.uploaded_at ?? null,
      uploaded_by: row?.uploaded_by ?? null,
      reviewed_at: row?.reviewed_at ?? null,
      review_note: row?.review_note ?? null,
    };
  });
}

export async function listDocuments(investorId, client = undefined) {
  const investor = await findInvestor(investorId, client);
  const rows = await query(
    `select * from investor_documents where investor_id = ?1 and nominee_id is null order by kind asc`,
    [investorId],
    client,
  );
  const nomineeRows = await query(
    `select d.*, n.name as nominee_name, n.relation, n.share_percent
       from investor_documents d join nominees n on n.id = d.nominee_id
      where d.investor_id = ?1 and d.kind = 'NOMINEE_PHOTO'
      order by n.id asc`,
    [investorId],
    client,
  );
  return {
    slots: buildDocumentSlots(investor, rows.rows),
    nominee_photos: nomineeRows.rows.map((row) => ({
      nominee_id: row.nominee_id,
      nominee_name: row.nominee_name,
      relation: row.relation,
      share_percent: row.share_percent,
      has_file: Boolean(row.data),
      status: row.data ? row.status : 'MISSING',
      mime: row.mime,
      size: row.size,
      uploaded_at: row.uploaded_at,
      reviewed_at: row.reviewed_at,
      review_note: row.review_note,
    })),
    pending_review: [...rows.rows, ...nomineeRows.rows].filter((row) => row.status === 'PENDING').length,
  };
}

/** Super Admin verification decision for one uploaded slot. */
export async function reviewDocument(investorId, kind, { status, note = null }, actor, req, { nomineeId = null } = {}) {
  assertKind(kind);
  if (!REVIEW_STATUSES.includes(status)) throw badRequest('Review status must be VERIFIED or REJECTED');
  if (status === 'REJECTED' && !note) throw badRequest('Add a short reason so the member knows what to fix');

  return withTransaction(async (client) => {
    const investor = await findInvestor(investorId, client);
    if (kind === 'NOMINEE_PHOTO') {
      if (!nomineeId) throw badRequest('Nominee id is required for a nominee photo');
      await findNominee(investorId, nomineeId, client);
    }

    let row = await findDocumentRow(investorId, kind, nomineeId, client);
    if (!row) {
      // Legacy uploads (before migration 003) have bytes but no review row yet.
      const hasLegacy = kind === 'PHOTO' ? Boolean(investor.photo) : kind === 'NID_FRONT' ? Boolean(investor.nid_scan) : false;
      if (!hasLegacy) throw badRequest(`Upload the ${DOCUMENT_LABELS[kind].toLowerCase()} before reviewing it`);
      const mime = kind === 'PHOTO' ? investor.photo_mime : investor.nid_scan_mime;
      const size = kind === 'PHOTO' ? investor.photo_size : investor.nid_scan_size;
      const inserted = await query(
        `insert into investor_documents (investor_id, nominee_id, kind, status, mime, size, uploaded_by, uploaded_at)
         values (?1, ?2, ?3, 'PENDING', ?4, ?5, 'ADMIN', ${NOW}) returning *`,
        [investorId, nomineeId, kind, mime, size],
        client,
      );
      row = inserted.rows[0];
    } else if (kind !== 'PHOTO' && kind !== 'NID_FRONT' && !row.data) {
      throw badRequest(`Upload the ${DOCUMENT_LABELS[kind].toLowerCase()} before reviewing it`);
    }

    const res = await query(
      `update investor_documents
          set status = ?2, reviewed_by = ?3, reviewed_at = ${NOW}, review_note = ?4
        where id = ?1 returning *`,
      [row.id, status, actor?.id ?? null, note],
      client,
    );
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.INVESTOR_DOCUMENT_REVIEWED,
        entity: 'investor_document',
        entityId: row.id,
        oldValue: { status: row.status },
        newValue: { status, note },
        meta: { investorId, nomineeId, kind },
        actor,
        req,
      },
      client,
    );
    return {
      kind,
      label: DOCUMENT_LABELS[kind],
      nominee_id: nomineeId ?? null,
      has_file: true,
      status,
      mime: res.rows[0].mime,
      size: res.rows[0].size,
      uploaded_at: res.rows[0].uploaded_at,
      uploaded_by: res.rows[0].uploaded_by,
      reviewed_at: res.rows[0].reviewed_at,
      review_note: res.rows[0].review_note,
    };
  });
}

/** Alert helper: how many uploaded documents are waiting for verification. */
export async function countPendingDocuments(investorId) {
  const res = await query(
    `select count(*) as count from investor_documents where investor_id = ?1 and status = 'PENDING'`,
    [investorId],
  );
  return Number(res.rows[0]?.count ?? 0);
}
