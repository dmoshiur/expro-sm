/**
 * Investor + nominee service.
 *
 * Rules enforced here (in addition to the database triggers):
 *  - mobile numbers are unique, NID is unique (via a deterministic HMAC hash)
 *  - NID values are stored AES-256-GCM encrypted, never in clear text
 *  - at most 3 nominees per investor, shares must total exactly 100%
 *  - nominee changes require the `investor:nominee:write` permission (SUPER_ADMIN)
 *  - investors are never hard deleted: `status` is flipped to INACTIVE
 *  - everything is audited with old/new values from the service layer
 */
import type { AdminRole, InvestorStatus, Prisma } from '../../generated/prisma/client';
import { prisma, type Tx } from '../../config/prisma';
import { AuditAction, AuditEntity } from '../../utils/auditActions';
import { decryptSafe, encrypt, hmac, maskMobile, maskNid } from '../../utils/encryption';
import { conflict, NotFoundError, unprocessable } from '../../utils/errors';
import { buildPaginated, skipTake } from '../../utils/http';
import { assertPermission } from '../../utils/permissions';
import { logger } from '../../utils/logger';
import { recordAudit, recordAuditTx, diffChanges, type AuditContext } from '../audit/audit.service';
import { getStorage } from '../storage/storage.service';
import type { CreateInvestorInput, ListInvestorsQuery, NomineeInput, UpdateInvestorInput } from '../../validators/investor.validator';

export interface InvestorActor extends AuditContext {
  adminId: string;
  role: AdminRole;
}

// ---------------------------------------------------------------------------
// serialisation / masking
// ---------------------------------------------------------------------------

const investorListSelect = {
  id: true,
  name: true,
  mobile: true,
  address: true,
  status: true,
  photoPublicId: true,
  nidEncrypted: true,
  nidPublicId: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { investments: true, nominees: true } },
} satisfies Prisma.InvestorSelect;

type InvestorRow = Prisma.InvestorGetPayload<{ select: typeof investorListSelect }>;

/**
 * Sensitive fields (full mobile, NID, NID scan) are only returned to roles that
 * hold `investor:sensitive:read` (SUPER_ADMIN). Everyone else gets masked data.
 */
export function serializeInvestor(investor: InvestorRow, role: AdminRole) {
  const canSeeSensitive = role === 'SUPER_ADMIN';
  const nid = canSeeSensitive ? decryptSafe(investor.nidEncrypted) : null;
  return {
    id: investor.id,
    name: investor.name,
    mobile: canSeeSensitive ? investor.mobile : maskMobile(investor.mobile),
    mobileMasked: maskMobile(investor.mobile),
    address: investor.address,
    status: investor.status,
    photoUrl: investor.photoPublicId ? getStorage().signedUrl(investor.photoPublicId, { ttlSeconds: 3600 }) : null,
    nid: canSeeSensitive ? nid : nid ? maskNid(nid) : null,
    hasNid: Boolean(investor.nidEncrypted),
    hasNidScan: Boolean(investor.nidPublicId),
    investmentCount: investor._count.investments,
    nomineeCount: investor._count.nominees,
    createdAt: investor.createdAt,
    updatedAt: investor.updatedAt,
  };
}

export function serializeNominee(nominee: {
  id: string;
  name: string;
  relation: string;
  mobile: string;
  nidEncrypted: string | null;
  sharePercent: number;
  createdAt?: Date;
  updatedAt?: Date;
}, role: AdminRole) {
  const canSeeSensitive = role === 'SUPER_ADMIN';
  const nid = canSeeSensitive ? decryptSafe(nominee.nidEncrypted) : null;
  return {
    id: nominee.id,
    name: nominee.name,
    relation: nominee.relation,
    mobile: canSeeSensitive ? nominee.mobile : maskMobile(nominee.mobile),
    nid: canSeeSensitive ? nid : nid ? maskNid(nid) : null,
    sharePercent: nominee.sharePercent,
    createdAt: nominee.createdAt,
    updatedAt: nominee.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function assertMobileAvailable(mobile: string, exceptId?: string): Promise<void> {
  const existing = await prisma.investor.findUnique({ where: { mobile }, select: { id: true } });
  if (existing && existing.id !== exceptId) {
    throw conflict('An investor with this mobile number already exists');
  }
}

async function assertNidAvailable(nidHash: string, exceptId?: string): Promise<void> {
  const existing = await prisma.investor.findUnique({ where: { nidHash }, select: { id: true } });
  if (existing && existing.id !== exceptId) {
    throw conflict('An investor with this NID already exists');
  }
}

function nomineeRows(investorId: string, nominees: NomineeInput[]) {
  return nominees.map((nominee) => ({
    investorId,
    name: nominee.name,
    relation: nominee.relation,
    mobile: nominee.mobile,
    nidEncrypted: nominee.nid ? encrypt(nominee.nid) : null,
    sharePercent: nominee.sharePercent,
  }));
}

export function validateNomineeShares(nominees: NomineeInput[]): void {
  if (nominees.length > 3) throw unprocessable('An investor can have at most 3 nominees');
  if (nominees.length === 0) return;
  const total = nominees.reduce((sum, nominee) => sum + nominee.sharePercent, 0);
  if (total !== 100) throw unprocessable(`Nominee shares must add up to exactly 100% (currently ${total}%)`);
  if (nominees.some((nominee) => nominee.sharePercent < 1)) throw unprocessable('Each nominee needs at least 1%');
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listInvestors(query: ListInvestorsQuery, role: AdminRole) {
  const where: Prisma.InvestorWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    // NOTE: SQLite's LIKE (what Prisma's `contains` compiles to) is case-insensitive for
    // ASCII, so the PostgreSQL-only `mode: 'insensitive'` argument is not needed - SQLite
    // rejects it. Non-ASCII text (e.g. Bangla) is compared case-sensitively.
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search } },
            { mobile: { contains: query.search } },
            { address: { contains: query.search } },
          ],
        }
      : {}),
  };

  const { skip, take } = skipTake(query.page, query.pageSize);
  const orderBy: Prisma.InvestorOrderByWithRelationInput =
    query.sortBy === 'name' ? { name: query.sortDir } : query.sortBy === 'mobile' ? { mobile: query.sortDir } : { [query.sortBy]: query.sortDir };

  const [rows, total] = await Promise.all([
    prisma.investor.findMany({ where, select: investorListSelect, orderBy, skip, take }),
    prisma.investor.count({ where }),
  ]);

  return buildPaginated(
    rows.map((row) => serializeInvestor(row, role)),
    total,
    query.page,
    query.pageSize,
  );
}

export async function getInvestorById(id: string, role: AdminRole) {
  const investor = await prisma.investor.findUnique({
    where: { id },
    select: {
      ...investorListSelect,
      nominees: true,
      notes: true,
      investments: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          totalAmount: true,
          installmentCount: true,
          status: true,
          createdAt: true,
          installments: {
            orderBy: { serial: 'asc' },
            select: { id: true, serial: true, amount: true, paidAmount: true, dueDate: true, status: true, paidAt: true },
          },
        },
      },
      smsLogs: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, toMobile: true, purpose: true, status: true, createdAt: true, body: true },
      },
    },
  });
  if (!investor) throw new NotFoundError('Investor');

  const totals = investor.investments.reduce(
    (acc, investment) => {
      acc.contracted += investment.totalAmount;
      for (const installment of investment.installments) {
        if (installment.status === 'PAID') acc.collected += installment.paidAmount || installment.amount;
      }
      return acc;
    },
    { contracted: 0n, collected: 0n },
  );

  return {
    ...serializeInvestor(investor, role),
    notes: investor.notes,
    nominees: investor.nominees.map((nominee) => serializeNominee(nominee, role)),
    investments: investor.investments.map((investment) => ({
      id: investment.id,
      totalAmount: investment.totalAmount.toString(),
      installmentCount: investment.installmentCount,
      status: investment.status,
      createdAt: investment.createdAt,
      installments: investment.installments.map((installment) => ({
        id: installment.id,
        serial: installment.serial,
        amount: installment.amount.toString(),
        paidAmount: installment.paidAmount.toString(),
        dueDate: installment.dueDate,
        status: installment.status,
        paidAt: installment.paidAt,
      })),
    })),
    smsLogs: investor.smsLogs.map((log) => ({
      ...log,
      toMobile: role === 'SUPER_ADMIN' ? log.toMobile : maskMobile(log.toMobile),
    })),
    summary: {
      contracted: totals.contracted.toString(),
      collected: totals.collected.toString(),
      outstanding: (totals.contracted - totals.collected).toString(),
    },
  };
}

export async function createInvestor(input: CreateInvestorInput, actor: InvestorActor) {
  await assertMobileAvailable(input.mobile);
  const nidHash = input.nid ? hmac(input.nid) : null;
  if (nidHash) await assertNidAvailable(nidHash);

  if (input.nominees.length > 0) {
    assertPermission(actor.role, 'investor:nominee:write');
    validateNomineeShares(input.nominees);
  }

  const created = await prisma.$transaction(async (tx) => {
    const investor = await tx.investor.create({
      data: {
        name: input.name,
        mobile: input.mobile,
        nidEncrypted: input.nid ? encrypt(input.nid) : null,
        nidHash,
        address: input.address ?? null,
        notes: input.notes ?? null,
        status: input.status as InvestorStatus,
      },
      select: { ...investorListSelect, notes: true, nominees: true },
    });

    if (input.nominees.length > 0) {
      await tx.nominee.createMany({ data: nomineeRows(investor.id, input.nominees) });
    }

    await recordAuditTx(tx, actor, {
      action: AuditAction.INVESTOR_CREATED,
      entity: AuditEntity.INVESTOR,
      entityId: investor.id,
      newValue: {
        name: investor.name,
        mobile: investor.mobile,
        address: investor.address,
        status: investor.status,
        nominees: input.nominees.map((nominee) => ({ name: nominee.name, sharePercent: nominee.sharePercent })),
        hasNid: Boolean(input.nid),
      },
    });

    return investor;
  });

  logger.info({ investorId: created.id, by: actor.adminId }, 'investor created');
  const full = await getInvestorById(created.id, actor.role);
  return full;
}

export async function updateInvestor(id: string, input: UpdateInvestorInput, actor: InvestorActor) {
  const existing = await prisma.investor.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Investor');

  if (input.mobile && input.mobile !== existing.mobile) await assertMobileAvailable(input.mobile, id);

  let nidHash = existing.nidHash;
  let nidEncrypted = existing.nidEncrypted;
  if (input.nid) {
    const hash = hmac(input.nid);
    if (hash !== existing.nidHash) {
      await assertNidAvailable(hash, id);
      nidHash = hash;
      nidEncrypted = encrypt(input.nid);
    }
  }

  const data: Prisma.InvestorUpdateInput = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
    ...(input.address !== undefined ? { address: input.address } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.status !== undefined ? { status: input.status as InvestorStatus } : {}),
    ...(nidHash !== existing.nidHash ? { nidHash, nidEncrypted } : {}),
  };

  await prisma.$transaction(async (tx) => {
    await tx.investor.update({ where: { id }, data });
    const { oldValue, newValue } = diffChanges(
      { name: existing.name, mobile: existing.mobile, address: existing.address, status: existing.status, nidHash: existing.nidHash },
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(nidHash !== existing.nidHash ? { nidHash } : {}),
      },
    );
    if (Object.keys(newValue).length > 0) {
      await recordAuditTx(tx, actor, {
        action: AuditAction.INVESTOR_UPDATED,
        entity: AuditEntity.INVESTOR,
        entityId: id,
        oldValue,
        newValue,
      });
    }
  });

  return getInvestorById(id, actor.role);
}

/**
 * Replaces the nominee list (SUPER_ADMIN only). Insert/update/delete happen in
 * one transaction so the deferred `shares = 100%` trigger sees the final state.
 */
export async function setNominees(investorId: string, nominees: NomineeInput[], actor: InvestorActor) {
  assertPermission(actor.role, 'investor:nominee:write');
  validateNomineeShares(nominees);

  const investor = await prisma.investor.findUnique({ where: { id: investorId }, include: { nominees: true } });
  if (!investor) throw new NotFoundError('Investor');

  await prisma.$transaction(async (tx) => {
    const keepIds = nominees.map((nominee) => nominee.id).filter(Boolean) as string[];
    await tx.nominee.deleteMany({ where: { investorId, id: { notIn: keepIds.length ? keepIds : ['00000000-0000-0000-0000-000000000000'] } } });

    for (const nominee of nominees) {
      const payload = {
        name: nominee.name,
        relation: nominee.relation,
        mobile: nominee.mobile,
        nidEncrypted: nominee.nid ? encrypt(nominee.nid) : null,
        sharePercent: nominee.sharePercent,
      };
      if (nominee.id) {
        await tx.nominee.updateMany({ where: { id: nominee.id, investorId }, data: payload });
      } else {
        await tx.nominee.create({ data: { ...payload, investorId } });
      }
    }

    const after = await tx.nominee.findMany({ where: { investorId }, orderBy: { createdAt: 'asc' } });
    await recordAuditTx(tx, actor, {
      action: AuditAction.NOMINEE_UPDATED,
      entity: AuditEntity.INVESTOR,
      entityId: investorId,
      oldValue: { nominees: investor.nominees.map((n) => ({ name: n.name, relation: n.relation, sharePercent: n.sharePercent })) },
      newValue: { nominees: after.map((n) => ({ name: n.name, relation: n.relation, sharePercent: n.sharePercent })) },
    });
  });

  logger.info({ investorId, by: actor.adminId }, 'nominees updated');
  return getInvestorById(investorId, actor.role);
}

/** Soft delete: never removes the row, keeps the money trail intact. */
export async function setInvestorStatus(id: string, status: InvestorStatus, actor: InvestorActor) {
  const investor = await prisma.investor.findUnique({ where: { id } });
  if (!investor) throw new NotFoundError('Investor');
  if (investor.status === status) return getInvestorById(id, actor.role);

  await prisma.$transaction(async (tx) => {
    await tx.investor.update({ where: { id }, data: { status } });
    await recordAuditTx(tx, actor, {
      action: status === 'INACTIVE' ? AuditAction.INVESTOR_DEACTIVATED : AuditAction.INVESTOR_REACTIVATED,
      entity: AuditEntity.INVESTOR,
      entityId: id,
      oldValue: { status: investor.status },
      newValue: { status },
    });
  });

  return getInvestorById(id, actor.role);
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

export async function attachPhoto(
  id: string,
  file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  actor: InvestorActor,
) {
  const investor = await prisma.investor.findUnique({ where: { id } });
  if (!investor) throw new NotFoundError('Investor');

  const asset = await getStorage().upload({
    buffer: file.buffer,
    mimetype: file.mimetype,
    originalName: file.originalname,
    folder: `investors/${id}/photo`,
    visibility: 'public',
  });

  if (investor.photoPublicId) await getStorage().destroy(investor.photoPublicId);

  await prisma.$transaction(async (tx) => {
    await tx.investor.update({ where: { id }, data: { photoPublicId: asset.publicId } });
    await recordAuditTx(tx, actor, {
      action: AuditAction.INVESTOR_PHOTO_UPDATED,
      entity: AuditEntity.INVESTOR,
      entityId: id,
      oldValue: { photoPublicId: investor.photoPublicId },
      newValue: { photoPublicId: asset.publicId, driver: asset.driver },
    });
  });

  return { publicId: asset.publicId, url: asset.url };
}

/** NID scans are uploaded as PRIVATE assets. */
export async function attachNidScan(
  id: string,
  file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  actor: InvestorActor,
) {
  const investor = await prisma.investor.findUnique({ where: { id } });
  if (!investor) throw new NotFoundError('Investor');

  const asset = await getStorage().upload({
    buffer: file.buffer,
    mimetype: file.mimetype,
    originalName: file.originalname,
    folder: `investors/${id}/nid`,
    visibility: 'private',
  });

  if (investor.nidPublicId) await getStorage().destroy(investor.nidPublicId);

  await prisma.$transaction(async (tx) => {
    await tx.investor.update({ where: { id }, data: { nidPublicId: asset.publicId } });
    await recordAuditTx(tx, actor, {
      action: AuditAction.INVESTOR_NID_UPDATED,
      entity: AuditEntity.INVESTOR,
      entityId: id,
      oldValue: { nidPublicId: investor.nidPublicId },
      newValue: { nidPublicId: asset.publicId, driver: asset.driver },
    });
  });

  return { publicId: asset.publicId };
}

/**
 * Issues a short lived signed URL for the private NID scan and records who
 * looked at it (regulatory requirement for identity documents).
 */
export async function getNidScanUrl(id: string, actor: InvestorActor, ttlSeconds = 300) {
  const investor = await prisma.investor.findUnique({ where: { id }, select: { nidPublicId: true } });
  if (!investor) throw new NotFoundError('Investor');
  if (!investor.nidPublicId) throw new NotFoundError('NID scan');

  const url = getStorage().signedUrl(investor.nidPublicId, { ttlSeconds });
  if (!url) throw new NotFoundError('NID scan');

  await recordAudit(actor, {
    action: AuditAction.INVESTOR_NID_VIEWED,
    entity: AuditEntity.INVESTOR,
    entityId: id,
    newValue: { ttlSeconds },
  });
  return { url, expiresInSeconds: ttlSeconds, driver: getStorage().driver };
}

// ---------------------------------------------------------------------------
// exports for other modules
// ---------------------------------------------------------------------------

export async function findInvestorOrFail(id: string, tx: Tx | typeof prisma = prisma) {
  const investor = await tx.investor.findUnique({ where: { id } });
  if (!investor) throw new NotFoundError('Investor');
  return investor;
}

export const investorService = {
  listInvestors,
  getInvestorById,
  createInvestor,
  updateInvestor,
  setNominees,
  setInvestorStatus,
  attachPhoto,
  attachNidScan,
  getNidScanUrl,
  serializeInvestor,
  serializeNominee,
  validateNomineeShares,
};
export default investorService;
