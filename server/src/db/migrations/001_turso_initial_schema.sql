-- ============================================================================
-- 001_turso_initial_schema.sql
-- Investor Installment Portal - full schema for Turso (libSQL / SQLite).
--
-- Replaces the former PostgreSQL migrations 001-003 (kept for reference under
-- tools/pg-to-turso/postgres-reference/). The schema is applied in one
-- transaction by src/db/migrate.js and recorded in schema_migrations.
--
-- Conventions
--   * Money is ALWAYS integer poisha (1 BDT = 100 poisha), stored as INTEGER
--     (64-bit). Never REAL. CHECK constraints reject non-integer values.
--   * Timestamps are TEXT in UTC ISO-8601 with milliseconds ('YYYY-MM-DDTHH:MM:SS.sssZ').
--   * Dates are TEXT 'YYYY-MM-DD'. Booleans are INTEGER 0/1.
--   * JSON is TEXT validated with json_valid().
--   * Foreign keys are declared here. Enforcement requires PRAGMA foreign_keys=ON,
--     which the application sets for local files and probes for remote Turso
--     (see src/db/client.js). Deferred PostgreSQL invariants are enforced in the
--     service layer before COMMIT (documented in docs/database.md).
--   * audit_logs is append-only (triggers RAISE on UPDATE and DELETE).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- admins
-- ---------------------------------------------------------------------------
CREATE TABLE admins (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL CHECK (length(name) <= 120),
  email                TEXT NOT NULL CHECK (length(email) <= 254),
  password_hash        TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  role                 TEXT NOT NULL DEFAULT 'VIEWER' CHECK (role IN ('SUPER_ADMIN', 'ACCOUNTANT', 'VIEWER')),
  totp_secret          TEXT,                       -- AES-256-GCM ciphertext (never plaintext)
  totp_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  totp_last_step       INTEGER,
  totp_confirmed_at    TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  password_changed_at  TEXT,
  disabled_reason      TEXT CHECK (disabled_reason IS NULL OR length(disabled_reason) <= 300),
  failed_login_count   INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until         TEXT,
  last_login_at        TEXT,
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (totp_enabled = 0 OR totp_secret IS NOT NULL)
);

CREATE UNIQUE INDEX admins_email_unique ON admins (lower(email));
CREATE INDEX admins_role_idx ON admins (role) WHERE is_active = 1;
CREATE INDEX admins_locked_idx ON admins (locked_until) WHERE locked_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- sessions (only the SHA-256 of the token is stored)
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  admin_id      INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  rotated_from  TEXT,
  rotated_to    TEXT,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  refreshed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ip            TEXT,
  user_agent    TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  revoked_at    TEXT,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR length(revoked_reason) <= 60),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX sessions_admin_idx ON sessions (admin_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
CREATE INDEX sessions_active_idx ON sessions (admin_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_token_hash_idx ON sessions (token_hash);

-- ---------------------------------------------------------------------------
-- investors
-- ---------------------------------------------------------------------------
CREATE TABLE investors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL CHECK (length(name) <= 120),
  mobile        TEXT NOT NULL CHECK (mobile GLOB '01[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  nid_encrypted TEXT,                       -- AES-256-GCM ciphertext
  nid_hash      TEXT CHECK (nid_hash IS NULL OR length(nid_hash) = 64),
  nid_last4     TEXT CHECK (nid_last4 IS NULL OR length(nid_last4) <= 4),
  address       TEXT CHECK (address IS NULL OR length(address) <= 500),
  photo         BLOB CHECK (photo IS NULL OR length(photo) <= 2097152),
  photo_mime    TEXT CHECK (photo_mime IS NULL OR length(photo_mime) <= 40),
  photo_size    INTEGER,
  nid_scan      BLOB CHECK (nid_scan IS NULL OR length(nid_scan) <= 4194304),   -- AES-256-GCM ciphertext, SUPER_ADMIN only
  nid_scan_mime TEXT CHECK (nid_scan_mime IS NULL OR length(nid_scan_mime) <= 40),
  nid_scan_size INTEGER,
  search_text   TEXT,                       -- maintained by triggers below
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'CLOSED')),
  notes         TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by    INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  updated_by    INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX investors_mobile_unique ON investors (mobile) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX investors_nid_hash_unique ON investors (nid_hash) WHERE nid_hash IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX investors_status_idx ON investors (status) WHERE deleted_at IS NULL;
CREATE INDEX investors_name_search_idx ON investors (lower(name));
CREATE INDEX investors_created_idx ON investors (created_at DESC);
CREATE INDEX investors_search_text_idx ON investors (search_text);

-- WHEN guards: only write when the value actually changes. An unconditional self-UPDATE
-- would also trip investors_touch_updated_at and overwrite imported updated_at values.
CREATE TRIGGER investors_search_text_insert AFTER INSERT ON investors
  WHEN NEW.search_text IS NOT lower(NEW.name || ' ' || NEW.mobile || ' ' || coalesce(NEW.address, ''))
BEGIN
  UPDATE investors
     SET search_text = lower(NEW.name || ' ' || NEW.mobile || ' ' || coalesce(NEW.address, ''))
   WHERE id = NEW.id;
END;

CREATE TRIGGER investors_search_text_update AFTER UPDATE OF name, mobile, address ON investors
  WHEN NEW.search_text IS NOT lower(NEW.name || ' ' || NEW.mobile || ' ' || coalesce(NEW.address, ''))
BEGIN
  UPDATE investors
     SET search_text = lower(NEW.name || ' ' || NEW.mobile || ' ' || coalesce(NEW.address, ''))
   WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- nominees (max 3 per investor, enforced immediately; shares must total 100
-- per investor, enforced in the service layer before COMMIT)
-- ---------------------------------------------------------------------------
CREATE TABLE nominees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  investor_id   INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (length(name) <= 120),
  relation      TEXT NOT NULL CHECK (length(relation) <= 60),
  mobile        TEXT NOT NULL CHECK (mobile GLOB '01[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  nid_encrypted TEXT,
  nid_hash      TEXT,
  nid_last4     TEXT CHECK (nid_last4 IS NULL OR length(nid_last4) <= 4),
  share_percent REAL NOT NULL CHECK (share_percent > 0 AND share_percent <= 100),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX nominees_investor_idx ON nominees (investor_id);

CREATE TRIGGER nominees_max_three_insert AFTER INSERT ON nominees
WHEN (SELECT count(*) FROM nominees WHERE investor_id = NEW.investor_id) > 3
BEGIN
  SELECT RAISE(ABORT, 'An investor can have at most 3 nominees');
END;

CREATE TRIGGER nominees_max_three_update AFTER UPDATE OF investor_id ON nominees
WHEN (SELECT count(*) FROM nominees WHERE investor_id = NEW.investor_id) > 3
BEGIN
  SELECT RAISE(ABORT, 'An investor can have at most 3 nominees');
END;

-- ---------------------------------------------------------------------------
-- investments
-- ---------------------------------------------------------------------------
CREATE TABLE investments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  investor_id       INTEGER NOT NULL REFERENCES investors(id) ON DELETE RESTRICT,
  title             TEXT CHECK (title IS NULL OR length(title) <= 160),
  total_amount      INTEGER NOT NULL CHECK (total_amount > 0),   -- poisha
  installment_count INTEGER NOT NULL CHECK (installment_count BETWEEN 1 AND 120),
  interval          TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (interval IN ('MONTHLY', 'WEEKLY')),
  first_due_date    TEXT,                                          -- YYYY-MM-DD
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
  notes             TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by        INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  updated_by        INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX investments_investor_idx ON investments (investor_id);
CREATE INDEX investments_status_idx ON investments (status);
CREATE INDEX investments_created_idx ON investments (created_at DESC);
CREATE INDEX investments_active_idx ON investments (id) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- installments
-- ---------------------------------------------------------------------------
CREATE TABLE installments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  investment_id    INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  serial           INTEGER NOT NULL CHECK (serial >= 1),
  amount           INTEGER NOT NULL CHECK (amount > 0),          -- poisha
  amount_paid      INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  due_date         TEXT NOT NULL,                                -- YYYY-MM-DD
  status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WAIVED', 'CANCELLED')),
  pay_token_hash   TEXT UNIQUE,
  token_expires_at TEXT,
  token_issued_at  TEXT,
  token_version    INTEGER NOT NULL DEFAULT 0,                   -- bumped on regeneration
  last_reminded_at TEXT,
  reminder_count   INTEGER NOT NULL DEFAULT 0,
  paid_at          TEXT,
  status_reason    TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  status_changed_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  status_changed_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (amount_paid <= amount),
  UNIQUE (investment_id, serial)
);

CREATE INDEX installments_status_idx ON installments (status);
CREATE INDEX installments_due_date_idx ON installments (due_date) WHERE status IN ('PENDING', 'PARTIALLY_PAID', 'OVERDUE');
CREATE INDEX installments_paid_at_idx ON installments (paid_at) WHERE paid_at IS NOT NULL;
CREATE INDEX installments_token_idx ON installments (pay_token_hash) WHERE pay_token_hash IS NOT NULL;
CREATE INDEX installments_due_status_due_date_idx ON installments (due_date, status);

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  installment_id       INTEGER NOT NULL REFERENCES installments(id) ON DELETE CASCADE,
  gateway              TEXT NOT NULL DEFAULT 'BKASH' CHECK (gateway IN ('BKASH', 'MANUAL')),
  gateway_payment_id   TEXT UNIQUE CHECK (gateway_payment_id IS NULL OR length(gateway_payment_id) <= 80),
  trx_id               TEXT CHECK (trx_id IS NULL OR length(trx_id) <= 80),
  invoice_number       TEXT CHECK (invoice_number IS NULL OR length(invoice_number) <= 80),
  amount               INTEGER NOT NULL CHECK (amount > 0),        -- poisha
  status               TEXT NOT NULL DEFAULT 'INITIATED'
                         CHECK (status IN ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED')),
  method               TEXT NOT NULL DEFAULT 'BKASH' CHECK (method IN ('BKASH', 'CASH', 'BANK', 'OTHER')),
  gateway_status       TEXT CHECK (gateway_status IS NULL OR length(gateway_status) <= 60),
  manual_reference     TEXT CHECK (manual_reference IS NULL OR length(manual_reference) <= 120),
  reference_note       TEXT CHECK (reference_note IS NULL OR length(reference_note) <= 500),
  recorded_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  payer_mobile         TEXT CHECK (payer_mobile IS NULL OR length(payer_mobile) <= 20),
  operation_id         TEXT CHECK (operation_id IS NULL OR length(operation_id) <= 40),
  check_count          INTEGER NOT NULL DEFAULT 0,
  raw_response         TEXT CHECK (raw_response IS NULL OR json_valid(raw_response)),
  failure_reason       TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 500),
  initiated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  verified_at          TEXT,
  paid_at              TEXT,
  refunded_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (method = 'BKASH' OR (manual_reference IS NOT NULL AND length(trim(manual_reference)) >= 3))
);

CREATE INDEX payments_installment_idx ON payments (installment_id);
CREATE INDEX payments_status_idx ON payments (status);
CREATE INDEX payments_created_idx ON payments (created_at DESC);
CREATE INDEX payments_method_idx ON payments (method);
CREATE INDEX payments_paid_at_idx ON payments (paid_at) WHERE status = 'SUCCESS';
CREATE INDEX payments_success_created_idx ON payments (created_at DESC) WHERE status = 'SUCCESS';
CREATE INDEX payments_gateway_payment_idx ON payments (gateway, gateway_payment_id);
-- trxId must be unique per gateway when present (replay protection)
CREATE UNIQUE INDEX payments_gateway_trx_unique ON payments (gateway, trx_id) WHERE trx_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- sms_logs
-- ---------------------------------------------------------------------------
CREATE TABLE sms_logs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  installment_id     INTEGER REFERENCES installments(id) ON DELETE SET NULL,
  investor_id        INTEGER REFERENCES investors(id) ON DELETE SET NULL,
  mobile_masked      TEXT NOT NULL CHECK (length(mobile_masked) <= 20),
  message_type       TEXT NOT NULL
                       CHECK (message_type IN ('PAYMENT_LINK', 'DUE_REMINDER', 'OVERDUE_REMINDER', 'PAYMENT_SUCCESS', 'RECEIPT', 'MANUAL', 'TEST')),
  provider           TEXT NOT NULL CHECK (length(provider) <= 30),
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 120),
  provider_status    TEXT NOT NULL DEFAULT 'QUEUED' CHECK (length(provider_status) <= 30),
  template_key       TEXT CHECK (template_key IS NULL OR length(template_key) <= 60),
  body_preview       TEXT CHECK (body_preview IS NULL OR length(body_preview) <= 160),
  error              TEXT CHECK (error IS NULL OR length(error) <= 300),
  sent_by_admin_id   INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX sms_logs_installment_idx ON sms_logs (installment_id);
CREATE INDEX sms_logs_created_idx ON sms_logs (created_at DESC);
CREATE INDEX sms_logs_type_idx ON sms_logs (message_type);

-- ---------------------------------------------------------------------------
-- audit_logs (append-only: UPDATE, DELETE are refused by triggers)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  actor_email TEXT CHECK (actor_email IS NULL OR length(actor_email) <= 254),   -- snapshot: survives admin deletion
  actor_role  TEXT CHECK (actor_role IS NULL OR length(actor_role) <= 20),
  action      TEXT NOT NULL CHECK (length(action) <= 60),
  entity      TEXT NOT NULL CHECK (length(entity) <= 40),
  entity_id   TEXT CHECK (entity_id IS NULL OR length(entity_id) <= 60),
  old_value   TEXT CHECK (old_value IS NULL OR json_valid(old_value)),
  new_value   TEXT CHECK (new_value IS NULL OR json_valid(new_value)),
  meta        TEXT CHECK (meta IS NULL OR json_valid(meta)),
  ip          TEXT,
  user_agent  TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  request_id  TEXT CHECK (request_id IS NULL OR length(request_id) <= 60),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity, entity_id);
CREATE INDEX audit_logs_admin_idx ON audit_logs (admin_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only (UPDATE is not permitted)');
END;

CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only (DELETE is not permitted)');
END;

-- ---------------------------------------------------------------------------
-- job_runs (in-process scheduler bookkeeping; makes jobs resumable/idempotent)
-- ---------------------------------------------------------------------------
CREATE TABLE job_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name        TEXT NOT NULL CHECK (length(job_name) <= 60),
  run_key         TEXT NOT NULL CHECK (length(run_key) <= 60),     -- e.g. the Dhaka date or window
  status          TEXT NOT NULL CHECK (status IN ('STARTED', 'SUCCESS', 'FAILED')),
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at     TEXT,
  duration_ms     INTEGER,
  items_processed INTEGER NOT NULL DEFAULT 0,
  detail          TEXT CHECK (detail IS NULL OR json_valid(detail)),
  error           TEXT CHECK (error IS NULL OR length(error) <= 500),
  UNIQUE (job_name, run_key)
);

CREATE INDEX job_runs_job_idx ON job_runs (job_name, started_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at safety net. Services set updated_at explicitly (required for
-- UPDATE ... RETURNING); this trigger fills it in for any UPDATE that did not.
-- The WHEN guard prevents recursion and never overrides an explicit value.
-- ---------------------------------------------------------------------------
CREATE TRIGGER admins_touch_updated_at AFTER UPDATE ON admins WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE admins SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER sessions_touch_updated_at AFTER UPDATE ON sessions WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Also skipped when only search_text changed, so the search trigger never bumps updated_at
-- (this keeps imported timestamps intact).
CREATE TRIGGER investors_touch_updated_at AFTER UPDATE ON investors
  WHEN NEW.updated_at = OLD.updated_at AND NEW.search_text IS OLD.search_text
BEGIN
  UPDATE investors SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER nominees_touch_updated_at AFTER UPDATE ON nominees WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE nominees SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER investments_touch_updated_at AFTER UPDATE ON investments WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE investments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER installments_touch_updated_at AFTER UPDATE ON installments WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE installments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER payments_touch_updated_at AFTER UPDATE ON payments WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE payments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER sms_logs_touch_updated_at AFTER UPDATE ON sms_logs WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE sms_logs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- ============================================================================
-- Deferred money / share invariants.
--
-- PostgreSQL enforced these with DEFERRABLE INITIALLY DEFERRED constraint triggers
-- (checked at COMMIT). SQLite has no deferred triggers, so the same rules are
-- split in two:
--   1. Outside an application transaction (no row in txn_scope, e.g. a manual
--      SQL session) the rule is checked immediately after each row change.
--   2. Inside an application transaction (withTransaction sets txn_scope) the
--      trigger only records the affected investment / investor in
--      txn_deferred_checks. db/client.js verifies those records just before COMMIT
--      and rolls the whole transaction back on any violation, so multi-row
--      rebalancing edits stay atomic exactly as they were.
-- Both tables are written only by the application's write transactions; SQLite
-- allows one writer at a time, so the marker cannot leak to another transaction.
-- ============================================================================
CREATE TABLE IF NOT EXISTS txn_scope (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);
CREATE TABLE IF NOT EXISTS txn_deferred_checks (
  kind   TEXT NOT NULL CHECK (kind IN ('INVESTMENT_SUM', 'NOMINEE_SHARES')),
  ref_id INTEGER NOT NULL,
  PRIMARY KEY (kind, ref_id)
);

-- Installments of an investment must add up to investments.total_amount (rows > 0).
CREATE TRIGGER installments_sum_immediate_insert AFTER INSERT ON installments
WHEN NOT EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  SELECT RAISE(ABORT, 'Installments must total the investment total')
   WHERE EXISTS (
     SELECT 1 FROM investments v
      WHERE v.id = NEW.investment_id
        AND (SELECT count(*) FROM installments i WHERE i.investment_id = v.id) > 0
        AND (SELECT coalesce(sum(i.amount), 0) FROM installments i WHERE i.investment_id = v.id) <> v.total_amount
   );
END;

CREATE TRIGGER installments_sum_immediate_update AFTER UPDATE OF amount, investment_id ON installments
WHEN NOT EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  SELECT RAISE(ABORT, 'Installments must total the investment total')
   WHERE EXISTS (
     SELECT 1 FROM investments v
      WHERE v.id IN (OLD.investment_id, NEW.investment_id)
        AND (SELECT count(*) FROM installments i WHERE i.investment_id = v.id) > 0
        AND (SELECT coalesce(sum(i.amount), 0) FROM installments i WHERE i.investment_id = v.id) <> v.total_amount
   );
END;

CREATE TRIGGER installments_sum_immediate_delete AFTER DELETE ON installments
WHEN NOT EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  SELECT RAISE(ABORT, 'Installments must total the investment total')
   WHERE EXISTS (
     SELECT 1 FROM investments v
      WHERE v.id = OLD.investment_id
        AND (SELECT count(*) FROM installments i WHERE i.investment_id = v.id) > 0
        AND (SELECT coalesce(sum(i.amount), 0) FROM installments i WHERE i.investment_id = v.id) <> v.total_amount
   );
END;

CREATE TRIGGER installments_sum_defer_insert AFTER INSERT ON installments
WHEN EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  INSERT OR IGNORE INTO txn_deferred_checks (kind, ref_id) VALUES ('INVESTMENT_SUM', NEW.investment_id);
END;

CREATE TRIGGER installments_sum_defer_update AFTER UPDATE OF amount, investment_id ON installments
WHEN EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  INSERT OR IGNORE INTO txn_deferred_checks (kind, ref_id) VALUES ('INVESTMENT_SUM', OLD.investment_id);
  INSERT OR IGNORE INTO txn_deferred_checks (kind, ref_id) VALUES ('INVESTMENT_SUM', NEW.investment_id);
END;

CREATE TRIGGER installments_sum_defer_delete AFTER DELETE ON installments
WHEN EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  INSERT OR IGNORE INTO txn_deferred_checks (kind, ref_id) VALUES ('INVESTMENT_SUM', OLD.investment_id);
END;

-- Changing investments.total_amount is refused while installments exist that do not add up to it.
CREATE TRIGGER investments_total_immediate AFTER UPDATE OF total_amount ON investments
WHEN NEW.total_amount <> OLD.total_amount AND NOT EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  SELECT RAISE(ABORT, 'Cannot change total: installments do not add up to the new total')
   WHERE (SELECT count(*) FROM installments i WHERE i.investment_id = NEW.id) > 0
     AND (SELECT coalesce(sum(i.amount), 0) FROM installments i WHERE i.investment_id = NEW.id) <> NEW.total_amount;
END;

CREATE TRIGGER investments_total_defer AFTER UPDATE OF total_amount ON investments
WHEN NEW.total_amount <> OLD.total_amount AND EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  INSERT OR IGNORE INTO txn_deferred_checks (kind, ref_id) VALUES ('INVESTMENT_SUM', NEW.id);
END;

-- Nominee shares must total 100% (hundredths, to avoid REAL rounding drift) for an investor
-- that has any nominees. The max-three rule stays immediate (nominees_max_three_*).
CREATE TRIGGER nominees_shares_immediate_insert AFTER INSERT ON nominees
WHEN NOT EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  SELECT RAISE(ABORT, 'Nominee shares must total 100%')
   WHERE (SELECT count(*) FROM nominees n WHERE n.investor_id = NEW.investor_id) > 0
     AND cast(round((SELECT coalesce(sum(n.share_percent), 0) FROM nominees n WHERE n.investor_id = NEW.investor_id) * 100) AS INTEGER) <> 10000;
END;

CREATE TRIGGER nominees_shares_immediate_update AFTER UPDATE OF share_percent, investor_id ON nominees
WHEN NOT EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  SELECT RAISE(ABORT, 'Nominee shares must total 100%')
   WHERE EXISTS (
     SELECT 1 FROM (SELECT OLD.investor_id AS investor_id UNION SELECT NEW.investor_id AS investor_id) x
      WHERE (SELECT count(*) FROM nominees n WHERE n.investor_id = x.investor_id) > 0
        AND cast(round((SELECT coalesce(sum(n.share_percent), 0) FROM nominees n WHERE n.investor_id = x.investor_id) * 100) AS INTEGER) <> 10000
   );
END;

CREATE TRIGGER nominees_shares_immediate_delete AFTER DELETE ON nominees
WHEN NOT EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  SELECT RAISE(ABORT, 'Nominee shares must total 100%')
   WHERE (SELECT count(*) FROM nominees n WHERE n.investor_id = OLD.investor_id) > 0
     AND cast(round((SELECT coalesce(sum(n.share_percent), 0) FROM nominees n WHERE n.investor_id = OLD.investor_id) * 100) AS INTEGER) <> 10000;
END;

CREATE TRIGGER nominees_shares_defer_insert AFTER INSERT ON nominees
WHEN EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  INSERT OR IGNORE INTO txn_deferred_checks (kind, ref_id) VALUES ('NOMINEE_SHARES', NEW.investor_id);
END;

CREATE TRIGGER nominees_shares_defer_update AFTER UPDATE OF share_percent, investor_id ON nominees
WHEN EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  INSERT OR IGNORE INTO txn_deferred_checks (kind, ref_id) VALUES ('NOMINEE_SHARES', OLD.investor_id);
  INSERT OR IGNORE INTO txn_deferred_checks (kind, ref_id) VALUES ('NOMINEE_SHARES', NEW.investor_id);
END;

CREATE TRIGGER nominees_shares_defer_delete AFTER DELETE ON nominees
WHEN EXISTS (SELECT 1 FROM txn_scope)
BEGIN
  INSERT OR IGNORE INTO txn_deferred_checks (kind, ref_id) VALUES ('NOMINEE_SHARES', OLD.investor_id);
END;
