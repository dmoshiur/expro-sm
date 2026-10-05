-- ===========================================================================
-- Investor Installment Portal - initial schema (Turso / libSQL / SQLite)
--
-- Ported from the Supabase/PostgreSQL migration of the same name. Everything
-- that SQLite can express is preserved:
--
--   * 64-bit INTEGER money columns (poisha), NOT NULL booleans, ISO-8601 UTC
--     DATETIME text, JSONB text for raw gateway payloads and audit snapshots
--   * enums as TEXT + CHECK constraints (PostgreSQL native enums were strict,
--     so SQLite gets an explicit domain check - same guarantee)
--   * UNIQUE indexes (including the partial (gateway, trxId) index that only
--     applies to non-NULL transaction ids), FK actions and query indexes
--   * append-only triggers on audit_logs, and the "at most 3 nominees" guard
--
-- NOT portable, and therefore enforced in the service layer plus
-- `npm run db:check` (scripts/check-invariants.mjs):
--
--   * "installment amounts must sum to the investment total" and
--     "nominee shares must sum to 100" were DEFERRED CONSTRAINT TRIGGERS in
--     PostgreSQL: they were checked at COMMIT time, which is what allowed a
--     multi-statement edit inside one transaction. SQLite has no deferred
--     triggers, so those two invariants are validated by the services on every
--     write and audited by the integrity checker.
--
-- Applied by scripts/apply-migrations.mjs (`npm run db:migrate`), which works
-- against a local `file:` database and against a remote `libsql://` Turso
-- database alike.
-- ===========================================================================

-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'VIEWER',
    "twoFASecret" TEXT,
    "twoFAEnabled" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "admins_role_valid" CHECK ("role" IN ('SUPER_ADMIN', 'ACCOUNTANT', 'VIEWER')),
    CONSTRAINT "admins_failed_login_count_valid" CHECK ("failedLoginCount" >= 0)
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "replacedByHash" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "investors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "nidEncrypted" TEXT,
    "nidHash" TEXT,
    "address" TEXT,
    "photoPublicId" TEXT,
    "nidPublicId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "investors_status_valid" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
    -- Bangladeshi mobile numbers: 01[3-9]XXXXXXXX or +8801[3-9]XXXXXXXX
    CONSTRAINT "investors_mobile_format" CHECK (
        "mobile" GLOB '01[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
        OR "mobile" GLOB '+8801[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
    )
);

-- CreateTable
CREATE TABLE "nominees" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "investorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "nidEncrypted" TEXT,
    "sharePercent" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "nominees_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "investors" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "nominees_share_percent_range" CHECK ("sharePercent" >= 1 AND "sharePercent" <= 100),
    CONSTRAINT "nominees_mobile_format" CHECK (
        "mobile" GLOB '01[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
        OR "mobile" GLOB '+8801[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
    )
);

-- CreateTable
CREATE TABLE "investments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "investorId" TEXT NOT NULL,
    "totalAmount" BIGINT NOT NULL,
    "installmentCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "investments_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "investors" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "investments_status_valid" CHECK ("status" IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
    CONSTRAINT "investments_total_amount_positive" CHECK ("totalAmount" > 0),
    CONSTRAINT "investments_installment_count_range" CHECK ("installmentCount" >= 1 AND "installmentCount" <= 120)
);

-- CreateTable
CREATE TABLE "installments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "investmentId" TEXT NOT NULL,
    "serial" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "paidAmount" BIGINT NOT NULL DEFAULT 0,
    "dueDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payTokenHash" TEXT,
    "tokenExpiresAt" DATETIME,
    "lastRemindedAt" DATETIME,
    "paidAt" DATETIME,
    "waivedReason" TEXT,
    "cancelledReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "installments_investmentId_fkey" FOREIGN KEY ("investmentId") REFERENCES "investments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "installments_status_valid" CHECK ("status" IN ('PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WAIVED', 'CANCELLED')),
    CONSTRAINT "installments_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "installments_paid_amount_valid" CHECK ("paidAmount" >= 0 AND "paidAmount" <= "amount"),
    CONSTRAINT "installments_serial_positive" CHECK ("serial" >= 1)
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installmentId" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "gatewayPaymentId" TEXT,
    "trxId" TEXT,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "method" TEXT NOT NULL,
    "manualReference" TEXT,
    "note" TEXT,
    "receiptNumber" TEXT,
    "recordedByAdminId" TEXT,
    "rawResponse" JSONB,
    "failureReason" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "payments_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "installments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "payments_recordedByAdminId_fkey" FOREIGN KEY ("recordedByAdminId") REFERENCES "admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "payments_gateway_valid" CHECK ("gateway" IN ('BKASH', 'NAGAD', 'MANUAL')),
    CONSTRAINT "payments_status_valid" CHECK ("status" IN ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED')),
    CONSTRAINT "payments_method_valid" CHECK ("method" IN ('BKASH', 'CASH', 'BANK', 'OTHER')),
    CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0),
    -- a manual (cash/bank) entry always carries a reference; a bKash gateway
    -- payment is identified by its gateway ids instead
    CONSTRAINT "payments_manual_reference_required" CHECK (
        ("method" = 'BKASH' AND "gateway" = 'BKASH')
        OR ("manualReference" IS NOT NULL AND length(trim("manualReference")) >= 3)
    )
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sms_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "investorId" TEXT,
    "installmentId" TEXT,
    "toMobile" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'PAYMENT_LINK',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "error" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sms_logs_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "investors" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "sms_logs_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "installments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "sms_logs_purpose_valid" CHECK ("purpose" IN ('PAYMENT_LINK', 'REMINDER_DUE', 'REMINDER_OVERDUE', 'MANUAL', 'BULK')),
    CONSTRAINT "sms_logs_status_valid" CHECK ("status" IN ('QUEUED', 'SENT', 'FAILED'))
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE INDEX "admins_role_idx" ON "admins"("role");

-- CreateIndex
CREATE INDEX "admins_isActive_idx" ON "admins"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_adminId_idx" ON "refresh_tokens"("adminId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "investors_mobile_key" ON "investors"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "investors_nidHash_key" ON "investors"("nidHash");

-- CreateIndex
CREATE INDEX "investors_status_idx" ON "investors"("status");

-- CreateIndex
CREATE INDEX "investors_name_idx" ON "investors"("name");

-- CreateIndex
CREATE INDEX "investors_createdAt_idx" ON "investors"("createdAt");

-- CreateIndex
CREATE INDEX "nominees_investorId_idx" ON "nominees"("investorId");

-- CreateIndex
CREATE INDEX "investments_investorId_idx" ON "investments"("investorId");

-- CreateIndex
CREATE INDEX "investments_status_idx" ON "investments"("status");

-- CreateIndex
CREATE INDEX "investments_createdAt_idx" ON "investments"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "installments_payTokenHash_key" ON "installments"("payTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "installments_investmentId_serial_key" ON "installments"("investmentId", "serial");

-- CreateIndex
CREATE INDEX "installments_status_dueDate_idx" ON "installments"("status", "dueDate");

-- CreateIndex
CREATE INDEX "installments_dueDate_idx" ON "installments"("dueDate");

-- CreateIndex
CREATE INDEX "installments_investmentId_idx" ON "installments"("investmentId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_gatewayPaymentId_key" ON "payments"("gatewayPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_receiptNumber_key" ON "payments"("receiptNumber");

-- CreateIndex
CREATE INDEX "payments_installmentId_idx" ON "payments"("installmentId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_createdAt_idx" ON "payments"("createdAt");

-- CreateIndex
CREATE INDEX "payments_trxId_idx" ON "payments"("trxId");

-- CreateIndex
CREATE INDEX "payments_method_idx" ON "payments"("method");

-- CreateIndex
CREATE INDEX "audit_logs_adminId_idx" ON "audit_logs"("adminId");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entityId_idx" ON "audit_logs"("entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "sms_logs_investorId_idx" ON "sms_logs"("investorId");

-- CreateIndex
CREATE INDEX "sms_logs_installmentId_idx" ON "sms_logs"("installmentId");

-- CreateIndex
CREATE INDEX "sms_logs_createdAt_idx" ON "sms_logs"("createdAt");

-- CreateIndex
CREATE INDEX "sms_logs_status_idx" ON "sms_logs"("status");

-- CreateIndex
-- A gateway transaction id may only ever be used once. NULL (payments that are
-- still INITIATED) is excluded, so a partial index - not a plain unique one.
CREATE UNIQUE INDEX "payments_gateway_trx_id_key" ON "payments" ("gateway", "trxId") WHERE "trxId" IS NOT NULL;

-- CreateIndex
-- Fast "due / overdue" lookups used by the reminder + overdue jobs.
CREATE INDEX "installments_open_due_idx" ON "installments" ("dueDate") WHERE "status" IN ('PENDING', 'PARTIALLY_PAID', 'OVERDUE');

-- CreateIndex
-- Fast reconciliation scan (pending gateway payments, oldest first).
CREATE INDEX "payments_pending_gateway_idx" ON "payments" ("status", "createdAt") WHERE "status" IN ('INITIATED', 'PENDING');

-- CreateIndex
-- Dashboard / reports: "collected in period" scans only successful payments.
CREATE INDEX "payments_success_completed_idx" ON "payments" ("completedAt") WHERE "status" = 'SUCCESS';

-- ===========================================================================
-- Hand-written hardening (cannot be expressed in the Prisma schema language)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. audit_logs is append-only
--
-- PostgreSQL used one trigger function for UPDATE and DELETE; SQLite triggers
-- are per-event, so there are two. TRUNCATE does not exist in SQLite, and both
-- events are blocked for every role - including the application.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "audit_logs_no_update"
BEFORE UPDATE ON "audit_logs"
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only (UPDATE is not permitted)');
END;

CREATE TRIGGER "audit_logs_no_delete"
BEFORE DELETE ON "audit_logs"
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only (DELETE is not permitted)');
END;

-- ---------------------------------------------------------------------------
-- 2. Nominees: at most 3 per investor
--
-- The share-range and mobile-format rules are CHECK constraints above; the
-- "shares add up to exactly 100" rule needs COMMIT-time visibility and is
-- enforced by the service + `npm run db:check`.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "nominees_max_three_guard_insert"
BEFORE INSERT ON "nominees"
BEGIN
  SELECT RAISE(ABORT, 'An investor may have at most 3 nominees (attempted to add a 4th)')
  WHERE (SELECT COUNT(*) FROM "nominees" WHERE "investorId" = NEW."investorId") >= 3;
END;

CREATE TRIGGER "nominees_max_three_guard_update"
BEFORE UPDATE ON "nominees"
BEGIN
  SELECT RAISE(ABORT, 'An investor may have at most 3 nominees (attempted to add a 4th)')
  WHERE (
    SELECT COUNT(*) FROM "nominees"
    WHERE "investorId" = NEW."investorId" AND "id" <> NEW."id"
  ) >= 3;
END;

-- ---------------------------------------------------------------------------
-- 3. Every table reachable only through the API
--
-- SQLite/Turso has no PostgREST-style HTTP surface and no row level security:
-- the database is reachable only with the auth token, which lives in the
-- server environment. Nothing to enable here - documented in the README.
-- ---------------------------------------------------------------------------
