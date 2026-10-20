-- ============================================================================
-- 003_investor_experience.sql
-- Investor experience upgrade: wallet ledger, document verification workflow,
-- membership approval / account freeze, Bangla name, and support inquiries.
--
-- Additive only. Existing investors are backfilled to:
--   * membership_status = 'APPROVED' (they already exist in the ledger)
--   * documents left without a row (nothing is claimed to be verified)
--
-- Money is integer poisha everywhere (see 001). A wallet ledger row stores a
-- POSITIVE amount plus an explicit direction, so a signed balance is always
--   sum(CREDIT) - sum(DEBIT)  over rows whose status is 'COMPLETED'.
-- Pending rows (deposit / withdrawal requests) never affect the balance.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- investors: Bangla name, membership approval, freeze flag
-- ---------------------------------------------------------------------------
ALTER TABLE investors ADD COLUMN name_bangla TEXT CHECK (name_bangla IS NULL OR length(name_bangla) <= 120);
ALTER TABLE investors ADD COLUMN membership_status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (membership_status IN ('PENDING', 'APPROVED', 'REJECTED'));
ALTER TABLE investors ADD COLUMN membership_note TEXT CHECK (membership_note IS NULL OR length(membership_note) <= 500);
ALTER TABLE investors ADD COLUMN membership_decided_at TEXT;
ALTER TABLE investors ADD COLUMN membership_decided_by INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE investors ADD COLUMN frozen_at TEXT;
ALTER TABLE investors ADD COLUMN frozen_reason TEXT CHECK (frozen_reason IS NULL OR length(frozen_reason) <= 500);

-- Existing rows predate the verification workflow: they are already members.
UPDATE investors SET membership_status = 'APPROVED', membership_decided_at = '2026-01-01T00:00:00.000Z'
 WHERE membership_status = 'PENDING';

CREATE INDEX investors_membership_idx ON investors (membership_status) WHERE deleted_at IS NULL;
CREATE INDEX investors_frozen_idx ON investors (frozen_at) WHERE frozen_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- investor_documents: upload + review state per document kind
--
--   PHOTO         bytes live in investors.photo      (public to staff/self)
--   NID_FRONT     bytes live in investors.nid_scan   (encrypted, SUPER_ADMIN)
--   NID_BACK      bytes live in this table           (encrypted)
--   SIGNATURE     bytes live in this table           (encrypted)
--   NOMINEE_PHOTO bytes live in this table           (encrypted, nominee_id set)
--
-- Every upload resets the row to PENDING. A Super Admin reviews it to
-- VERIFIED or REJECTED; the note explains a rejection to the investor.
-- ---------------------------------------------------------------------------
CREATE TABLE investor_documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  investor_id   INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  nominee_id    INTEGER REFERENCES nominees(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL
                  CHECK (kind IN ('PHOTO', 'NID_FRONT', 'NID_BACK', 'SIGNATURE', 'NOMINEE_PHOTO')),
  status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  mime          TEXT CHECK (mime IS NULL OR length(mime) <= 40),
  size          INTEGER CHECK (size IS NULL OR size >= 0),
  data          BLOB,                        -- AES-256-GCM ciphertext for NID_BACK / SIGNATURE / NOMINEE_PHOTO
  uploaded_by   TEXT NOT NULL DEFAULT 'ADMIN' CHECK (uploaded_by IN ('ADMIN', 'INVESTOR')),
  uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_by   INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  reviewed_at   TEXT,
  review_note   TEXT CHECK (review_note IS NULL OR length(review_note) <= 500),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (kind <> 'NOMINEE_PHOTO' OR nominee_id IS NOT NULL),
  CHECK (kind = 'NOMINEE_PHOTO' OR nominee_id IS NULL)
);

CREATE UNIQUE INDEX investor_documents_investor_kind_unique
  ON investor_documents (investor_id, kind) WHERE nominee_id IS NULL;
CREATE UNIQUE INDEX investor_documents_nominee_kind_unique
  ON investor_documents (nominee_id, kind) WHERE nominee_id IS NOT NULL;
CREATE INDEX investor_documents_review_idx ON investor_documents (status, uploaded_at DESC);

CREATE TRIGGER investor_documents_touch_updated_at AFTER UPDATE ON investor_documents
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE investor_documents SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- wallet_transactions: deposits, withdrawals, earnings, adjustments, fees
--
-- status flow for a request: PENDING -> COMPLETED (approved) | REJECTED
-- admin ledger entries are written straight to COMPLETED (audited).
-- ---------------------------------------------------------------------------
CREATE TABLE wallet_transactions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  investor_id        INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  reference          TEXT NOT NULL UNIQUE CHECK (length(reference) <= 40),
  type               TEXT NOT NULL
                       CHECK (type IN ('DEPOSIT', 'WITHDRAWAL', 'EARNING', 'ADJUSTMENT', 'FEE')),
  direction          TEXT NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
  amount             INTEGER NOT NULL CHECK (amount > 0),            -- poisha
  status             TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED')),
  method             TEXT CHECK (method IN ('CASH', 'BKASH', 'BANK', 'OTHER')),
  external_reference TEXT CHECK (external_reference IS NULL OR length(external_reference) <= 120),
  note               TEXT CHECK (note IS NULL OR length(note) <= 500),
  requested_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at        TEXT,
  reviewed_by        INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  review_note        TEXT CHECK (review_note IS NULL OR length(review_note) <= 500),
  created_by         INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (type NOT IN ('DEPOSIT', 'EARNING') OR direction = 'CREDIT'),
  CHECK (type NOT IN ('WITHDRAWAL', 'FEE') OR direction = 'DEBIT')
);

CREATE INDEX wallet_transactions_investor_idx ON wallet_transactions (investor_id, created_at DESC);
CREATE INDEX wallet_transactions_status_idx ON wallet_transactions (status, requested_at DESC);
CREATE INDEX wallet_transactions_investor_status_idx ON wallet_transactions (investor_id, status);

CREATE TRIGGER wallet_transactions_touch_updated_at AFTER UPDATE ON wallet_transactions
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE wallet_transactions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- support_tickets + support_messages (investor inquiries -> admin inbox)
-- ---------------------------------------------------------------------------
CREATE TABLE support_tickets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no       TEXT NOT NULL UNIQUE CHECK (length(ticket_no) <= 40),
  investor_id     INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  subject         TEXT NOT NULL CHECK (length(subject) BETWEEN 3 AND 160),
  category        TEXT NOT NULL DEFAULT 'GENERAL'
                    CHECK (category IN ('GENERAL', 'PAYMENT', 'PENSION', 'WALLET', 'PROFILE', 'DOCUMENT')),
  priority        TEXT NOT NULL DEFAULT 'NORMAL'
                    CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  status          TEXT NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
  last_message_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_message_by TEXT CHECK (last_message_by IN ('INVESTOR', 'ADMIN')),
  assigned_to     INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  closed_at       TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX support_tickets_investor_idx ON support_tickets (investor_id, last_message_at DESC);
CREATE INDEX support_tickets_status_idx ON support_tickets (status, last_message_at DESC);

CREATE TRIGGER support_tickets_touch_updated_at AFTER UPDATE ON support_tickets
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE support_tickets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TABLE support_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('INVESTOR', 'ADMIN')),
  admin_id    INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  investor_id INTEGER REFERENCES investors(id) ON DELETE CASCADE,
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (author_type <> 'INVESTOR' OR investor_id IS NOT NULL),
  CHECK (author_type <> 'ADMIN' OR admin_id IS NOT NULL)
);

CREATE INDEX support_messages_ticket_idx ON support_messages (ticket_id, created_at ASC);
