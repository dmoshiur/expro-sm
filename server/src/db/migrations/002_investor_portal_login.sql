-- ============================================================================
-- 002_investor_portal_login.sql
-- Investor self-service portal: login credentials + sessions + richer profile.
--
--  * investors gains a human member code (INV-000123) used - together with the
--    mobile number - as the portal login id, portal credential/lockout
--    columns mirroring admins, and the personal/contact fields shown on the
--    member profile (email, alternate mobile, date of birth, gender,
--    father/husband + mother names, religion, education, present/permanent
--    address) so profiles stop being mostly empty.
--  * investor_sessions mirrors `sessions` but belongs to investors. The two
--    session systems (admin / investor) are deliberately separate tables and
--    separate cookies so an investor token can never act as an admin token.
--  * Existing rows: member codes are backfilled from the id, and the legacy
--    `address` is copied into `present_address` so the profile page has data
--    on day one. Portal login stays OFF (portal_enabled = 0, no password)
--    until an admin sets a password from the investor page.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- investors: member code + profile fields + portal credentials
-- ---------------------------------------------------------------------------
ALTER TABLE investors ADD COLUMN member_code TEXT CHECK (member_code IS NULL OR length(member_code) <= 20);

ALTER TABLE investors ADD COLUMN email TEXT CHECK (email IS NULL OR length(email) <= 254);
ALTER TABLE investors ADD COLUMN alternate_mobile TEXT
  CHECK (alternate_mobile IS NULL OR alternate_mobile GLOB '01[3-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]');
ALTER TABLE investors ADD COLUMN date_of_birth TEXT
  CHECK (date_of_birth IS NULL OR date_of_birth GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE investors ADD COLUMN gender TEXT CHECK (gender IS NULL OR gender IN ('MALE', 'FEMALE', 'OTHER'));
ALTER TABLE investors ADD COLUMN father_name TEXT CHECK (father_name IS NULL OR length(father_name) <= 120);
ALTER TABLE investors ADD COLUMN mother_name TEXT CHECK (mother_name IS NULL OR length(mother_name) <= 120);
ALTER TABLE investors ADD COLUMN religion TEXT CHECK (religion IS NULL OR length(religion) <= 60);
ALTER TABLE investors ADD COLUMN education TEXT CHECK (education IS NULL OR length(education) <= 120);
ALTER TABLE investors ADD COLUMN present_address TEXT CHECK (present_address IS NULL OR length(present_address) <= 500);
ALTER TABLE investors ADD COLUMN permanent_address TEXT CHECK (permanent_address IS NULL OR length(permanent_address) <= 500);

ALTER TABLE investors ADD COLUMN password_hash TEXT CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%');
ALTER TABLE investors ADD COLUMN portal_enabled INTEGER NOT NULL DEFAULT 0 CHECK (portal_enabled IN (0, 1));
ALTER TABLE investors ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));
ALTER TABLE investors ADD COLUMN password_changed_at TEXT;
ALTER TABLE investors ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0);
ALTER TABLE investors ADD COLUMN locked_until TEXT;
ALTER TABLE investors ADD COLUMN last_login_at TEXT;

-- Backfill for existing investors (member code is their permanent login id).
UPDATE investors SET member_code = 'INV-' || printf('%06d', id) WHERE member_code IS NULL;
UPDATE investors SET present_address = address WHERE present_address IS NULL AND address IS NOT NULL;

CREATE UNIQUE INDEX investors_member_code_unique ON investors (upper(member_code)) WHERE member_code IS NOT NULL;
CREATE INDEX investors_portal_idx ON investors (portal_enabled, last_login_at) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- investor_sessions (only the SHA-256 of the token is stored)
-- ---------------------------------------------------------------------------
CREATE TABLE investor_sessions (
  id            TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  investor_id   INTEGER NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
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

CREATE INDEX investor_sessions_investor_idx ON investor_sessions (investor_id);
CREATE INDEX investor_sessions_expires_idx ON investor_sessions (expires_at);
CREATE INDEX investor_sessions_active_idx ON investor_sessions (investor_id) WHERE revoked_at IS NULL;
CREATE INDEX investor_sessions_token_hash_idx ON investor_sessions (token_hash);

CREATE TRIGGER investor_sessions_touch_updated_at AFTER UPDATE ON investor_sessions WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE investor_sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
