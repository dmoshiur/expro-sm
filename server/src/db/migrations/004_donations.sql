-- ============================================================================
-- 004_donations.sql
-- Donates: investors contribute to welfare / charity funds through the same
-- payment gateway as installments, and get a digital receipt once the server
-- has verified the gateway transaction.
--
-- Donations are a separate ledger on purpose: they never touch installments,
-- investment totals or the wallet. Money is integer poisha everywhere.
-- ============================================================================

CREATE TABLE donations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  investor_id        INTEGER NOT NULL REFERENCES investors(id) ON DELETE RESTRICT,
  fund_code          TEXT NOT NULL CHECK (length(fund_code) <= 40),
  amount             INTEGER NOT NULL CHECK (amount > 0),            -- poisha
  status             TEXT NOT NULL DEFAULT 'INITIATED'
                       CHECK (status IN ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED')),
  gateway            TEXT NOT NULL DEFAULT 'BKASH' CHECK (gateway IN ('BKASH')),
  gateway_payment_id TEXT UNIQUE CHECK (gateway_payment_id IS NULL OR length(gateway_payment_id) <= 80),
  invoice_number     TEXT CHECK (invoice_number IS NULL OR length(invoice_number) <= 80),
  trx_id             TEXT CHECK (trx_id IS NULL OR length(trx_id) <= 80),
  gateway_status     TEXT CHECK (gateway_status IS NULL OR length(gateway_status) <= 60),
  failure_reason     TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 500),
  raw_response       TEXT CHECK (raw_response IS NULL OR json_valid(raw_response)),
  check_count        INTEGER NOT NULL DEFAULT 0,
  paid_at            TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A gateway transaction id can be credited once, across donations.
CREATE UNIQUE INDEX donations_trx_unique ON donations (gateway, trx_id) WHERE trx_id IS NOT NULL;
CREATE INDEX donations_investor_idx ON donations (investor_id, created_at);
CREATE INDEX donations_status_idx ON donations (status, created_at);
