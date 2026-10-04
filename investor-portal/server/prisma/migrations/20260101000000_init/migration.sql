-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'ACCOUNTANT', 'VIEWER');

-- CreateEnum
CREATE TYPE "InvestorStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "InvestmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InstallmentStatus" AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WAIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('BKASH', 'NAGAD', 'MANUAL');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BKASH', 'CASH', 'BANK', 'OTHER');

-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "SmsPurpose" AS ENUM ('PAYMENT_LINK', 'REMINDER_DUE', 'REMINDER_OVERDUE', 'MANUAL', 'BULK');

-- CreateTable
CREATE TABLE "admins" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'VIEWER',
    "twoFASecret" TEXT,
    "twoFAEnabled" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedByHash" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investors" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "nidEncrypted" TEXT,
    "nidHash" TEXT,
    "address" TEXT,
    "photoPublicId" TEXT,
    "nidPublicId" TEXT,
    "status" "InvestorStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nominees" (
    "id" UUID NOT NULL,
    "investorId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "nidEncrypted" TEXT,
    "sharePercent" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nominees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investments" (
    "id" UUID NOT NULL,
    "investorId" UUID NOT NULL,
    "totalAmount" BIGINT NOT NULL,
    "installmentCount" INTEGER NOT NULL,
    "status" "InvestmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installments" (
    "id" UUID NOT NULL,
    "investmentId" UUID NOT NULL,
    "serial" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "paidAmount" BIGINT NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'PENDING',
    "payTokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastRemindedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "waivedReason" TEXT,
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "installmentId" UUID NOT NULL,
    "gateway" "PaymentGateway" NOT NULL,
    "gatewayPaymentId" TEXT,
    "trxId" TEXT,
    "amount" BIGINT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "method" "PaymentMethod" NOT NULL,
    "manualReference" TEXT,
    "note" TEXT,
    "receiptNumber" TEXT,
    "recordedByAdminId" UUID,
    "rawResponse" JSONB,
    "failureReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "adminId" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_logs" (
    "id" UUID NOT NULL,
    "investorId" UUID,
    "installmentId" UUID,
    "toMobile" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "purpose" "SmsPurpose" NOT NULL DEFAULT 'PAYMENT_LINK',
    "status" "SmsStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
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
CREATE INDEX "installments_status_dueDate_idx" ON "installments"("status", "dueDate");

-- CreateIndex
CREATE INDEX "installments_dueDate_idx" ON "installments"("dueDate");

-- CreateIndex
CREATE INDEX "installments_investmentId_idx" ON "installments"("investmentId");

-- CreateIndex
CREATE UNIQUE INDEX "installments_investmentId_serial_key" ON "installments"("investmentId", "serial");

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

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nominees" ADD CONSTRAINT "nominees_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "investors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investments" ADD CONSTRAINT "investments_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "investors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_investmentId_fkey" FOREIGN KEY ("investmentId") REFERENCES "investments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "installments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recordedByAdminId_fkey" FOREIGN KEY ("recordedByAdminId") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "investors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "installments"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written hardening (cannot be expressed in the Prisma schema language)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Row Level Security
--
-- Supabase exposes every table in the `public` schema through PostgREST to the
-- `anon` / `authenticated` roles. Enabling RLS with NO policies denies all
-- access to those roles while the owning role used by this Express server
-- (`postgres`) is unaffected. All database access therefore flows exclusively
-- through the server. Add policies here if a future version ever needs
-- client-side access.
-- ---------------------------------------------------------------------------
ALTER TABLE "admins"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investors"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "nominees"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investments"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "installments"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sms_logs"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings"        ENABLE ROW LEVEL SECURITY;

-- Belt and braces for a fresh Supabase project: revoke the wide grants.
REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON TABLES FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. audit_logs is append-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% is not permitted)', TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON "audit_logs";
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

-- UPDATE and DELETE are blocked. TRUNCATE is intentionally NOT blocked: only a
-- superuser/owner can run it, which is the documented break-glass path for data
-- retention pruning and test teardown. The application never issues it.

-- ---------------------------------------------------------------------------
-- 3. Nominees: at most 3 per investor, shares must add up to exactly 100
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nominees_max_three() RETURNS trigger AS $$
DECLARE
  nominee_count integer;
BEGIN
  SELECT COUNT(*) INTO nominee_count
  FROM "nominees"
  WHERE "investorId" = NEW."investorId"
    AND ("id" <> NEW."id" OR TG_OP = 'INSERT');

  IF nominee_count >= 3 THEN
    RAISE EXCEPTION 'An investor may have at most 3 nominees (attempted to add a 4th)'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."sharePercent" IS NULL OR NEW."sharePercent" < 1 OR NEW."sharePercent" > 100 THEN
    RAISE EXCEPTION 'Nominee sharePercent must be between 1 and 100' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS nominees_max_three_guard ON "nominees";
CREATE TRIGGER nominees_max_three_guard
  BEFORE INSERT OR UPDATE ON "nominees"
  FOR EACH ROW EXECUTE FUNCTION nominees_max_three();

-- Deferred: the shares only have to add up to 100 when the transaction commits,
-- so a multi-step edit inside one transaction is still possible.
CREATE OR REPLACE FUNCTION nominees_validate_share_total() RETURNS trigger AS $$
DECLARE
  v_investor_id uuid;
  v_total integer;
  v_count integer;
BEGIN
  v_investor_id := COALESCE(NEW."investorId", OLD."investorId");

  SELECT COALESCE(SUM("sharePercent"), 0), COUNT(*) INTO v_total, v_count
  FROM "nominees" WHERE "investorId" = v_investor_id;

  IF v_count > 0 AND v_total <> 100 THEN
    RAISE EXCEPTION 'Nominee shares for investor % add up to % (must be exactly 100)', v_investor_id, v_total
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS nominees_share_total_guard ON "nominees";
CREATE CONSTRAINT TRIGGER nominees_share_total_guard
  AFTER INSERT OR UPDATE OR DELETE ON "nominees"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nominees_validate_share_total();

-- ---------------------------------------------------------------------------
-- 4. Installments must sum to the investment total (deferred to commit time)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION installments_validate_total(p_investment_id uuid)
RETURNS void AS $$
DECLARE
  v_total bigint;
  v_sum   bigint;
  v_count integer;
BEGIN
  SELECT "totalAmount" INTO v_total FROM "investments" WHERE "id" = p_investment_id;
  IF v_total IS NULL THEN
    RETURN; -- investment is gone; nothing to validate
  END IF;

  SELECT COALESCE(SUM("amount"), 0), COUNT(*) INTO v_sum, v_count
  FROM "installments" WHERE "investmentId" = p_investment_id;

  IF v_count > 0 AND v_sum <> v_total THEN
    RAISE EXCEPTION
      'Installment amounts (%) must equal the investment total (%) for investment %', v_sum, v_total, p_investment_id
      USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION installments_total_guard_fn() RETURNS trigger AS $$
BEGIN
  PERFORM installments_validate_total(COALESCE(NEW."investmentId", OLD."investmentId"));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS installments_total_guard ON "installments";
CREATE CONSTRAINT TRIGGER installments_total_guard
  AFTER INSERT OR UPDATE OR DELETE ON "installments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION installments_total_guard_fn();

CREATE OR REPLACE FUNCTION investments_total_guard_fn() RETURNS trigger AS $$
BEGIN
  IF NEW."totalAmount" IS DISTINCT FROM OLD."totalAmount" THEN
    PERFORM installments_validate_total(NEW."id");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS investments_total_guard ON "investments";
CREATE CONSTRAINT TRIGGER investments_total_guard
  AFTER UPDATE ON "investments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION investments_total_guard_fn();

-- ---------------------------------------------------------------------------
-- 5. Domain / money CHECK constraints (defence in depth for the integer
--    poisha rule: nothing negative, nothing fractional, no float drift)
-- ---------------------------------------------------------------------------
ALTER TABLE "investments"
  ADD CONSTRAINT "investments_total_amount_positive" CHECK ("totalAmount" > 0),
  ADD CONSTRAINT "investments_installment_count_range" CHECK ("installmentCount" >= 1 AND "installmentCount" <= 120);

ALTER TABLE "installments"
  ADD CONSTRAINT "installments_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "installments_paid_amount_valid" CHECK ("paidAmount" >= 0 AND "paidAmount" <= "amount"),
  ADD CONSTRAINT "installments_serial_positive" CHECK ("serial" >= 1);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "payments_manual_reference_required"
    CHECK (("method" = 'BKASH' AND "gateway" = 'BKASH') OR ("manualReference" IS NOT NULL AND length(btrim("manualReference")) >= 3));

ALTER TABLE "investors"
  ADD CONSTRAINT "investors_mobile_format" CHECK ("mobile" ~ '^\+?[0-9]{10,15}$');

ALTER TABLE "nominees"
  ADD CONSTRAINT "nominees_share_percent_range" CHECK ("sharePercent" >= 1 AND "sharePercent" <= 100),
  ADD CONSTRAINT "nominees_mobile_format" CHECK ("mobile" ~ '^\+?[0-9]{10,15}$');

ALTER TABLE "admins"
  ADD CONSTRAINT "admins_failed_login_count_valid" CHECK ("failedLoginCount" >= 0);

-- ---------------------------------------------------------------------------
-- 6. Partial unique index: a gateway transaction id may only be used once
--    (NULL trxIds - e.g. payments still INITIATED - are ignored)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "payments_gateway_trx_id_key"
  ON "payments" ("gateway", "trxId")
  WHERE "trxId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. Unique NID hash per investor (ignoring NULLs) - explicit index so the
--    intent is visible in the database, complementing the Prisma @unique.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "investors_nid_hash_key" ON "investors" ("nidHash") WHERE "nidHash" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 8. Fast "due / overdue" lookups used by the reminder + overdue jobs
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "installments_open_due_idx"
  ON "installments" ("dueDate")
  WHERE "status" IN ('PENDING', 'PARTIALLY_PAID', 'OVERDUE');

CREATE INDEX IF NOT EXISTS "payments_pending_gateway_idx"
  ON "payments" ("status", "createdAt")
  WHERE "status" IN ('INITIATED', 'PENDING');
