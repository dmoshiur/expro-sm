-- ============================================================================
-- 001_initial_schema.sql
-- Investor Installment Portal - full schema.
--
-- Conventions
--   * Money is ALWAYS integer poisha (1 BDT = 100 poisha) stored in BIGINT.
--   * Every table has created_at / updated_at (except append-only logs).
--   * RLS is ENABLED on every table with NO policies: the PostgREST/anon path
--     can read nothing; our server connects as the table owner (owners bypass
--     RLS unless FORCE ROW LEVEL SECURITY is set, which we deliberately do not).
--   * audit_logs is append-only, enforced by triggers.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enumerations as CHECK constraints (easy to extend in later migrations)
-- ---------------------------------------------------------------------------
-- admins.role              : SUPER_ADMIN | ACCOUNTANT | VIEWER
-- admins.totp_*             : RFC 6238 TOTP
-- investors.status          : ACTIVE | INACTIVE | CLOSED
-- investments.status        : ACTIVE | COMPLETED | CANCELLED
-- installments.status       : PENDING | PARTIALLY_PAID | PAID | OVERDUE | WAIVED | CANCELLED
-- payments.status           : INITIATED | PENDING | SUCCESS | FAILED | CANCELLED | REFUNDED
-- payments.method           : BKASH | CASH | BANK | OTHER

-- ---------------------------------------------------------------------------
-- admins
-- ---------------------------------------------------------------------------
create table admins (
  id                  bigserial primary key,
  name                varchar(120) not null,
  email               varchar(254) not null,
  password_hash       text not null check (password_hash like 'scrypt$%'),
  role                varchar(20) not null default 'VIEWER'
                        check (role in ('SUPER_ADMIN', 'ACCOUNTANT', 'VIEWER')),
  totp_secret         text,                -- AES-256-GCM ciphertext (never plaintext)
  totp_enabled        boolean not null default false,
  must_change_password boolean not null default false,
  failed_login_count  integer not null default 0 check (failed_login_count >= 0),
  locked_until        timestamptz,
  last_login_at       timestamptz,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint admins_totp_enabled_requires_secret
    check ((totp_enabled = false) or (totp_secret is not null))
);

create unique index admins_email_unique on admins (lower(email));
create index admins_role_idx on admins (role) where is_active;

create trigger admins_set_updated_at before update on admins
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- sessions (server-side session records; only the SHA-256 of the token is kept)
-- ---------------------------------------------------------------------------
create table sessions (
  id            uuid primary key default gen_random_uuid(),
  admin_id      bigint not null references admins(id) on delete cascade,
  token_hash    text not null unique,
  -- rotation lineage: the session this one replaced, and the one that replaced it
  rotated_from  uuid,
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  refreshed_at  timestamptz not null default now(),
  ip            inet,
  user_agent    varchar(400),
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index sessions_admin_idx on sessions (admin_id);
create index sessions_expires_idx on sessions (expires_at);
create index sessions_active_idx on sessions (admin_id) where revoked_at is null;

create trigger sessions_set_updated_at before update on sessions
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- investors
-- ---------------------------------------------------------------------------
create table investors (
  id            bigserial primary key,
  name          varchar(120) not null,
  mobile        varchar(20) not null,       -- normalised 01XXXXXXXXX (unique)
  nid_encrypted text,                       -- AES-256-GCM ciphertext
  nid_hash      text,                       -- HMAC-SHA256 for exact search / dup checks
  nid_last4     varchar(4),
  address       varchar(500),
  photo         bytea,
  photo_mime    varchar(40),
  photo_size    integer,
  nid_scan      bytea,                      -- AES-256-GCM ciphertext, SUPER_ADMIN only
  nid_scan_mime varchar(40),
  nid_scan_size integer,
  status        varchar(20) not null default 'ACTIVE'
                  check (status in ('ACTIVE', 'INACTIVE', 'CLOSED')),
  notes         varchar(2000),
  created_by    bigint references admins(id) on delete set null,
  updated_by    bigint references admins(id) on delete set null,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint investors_mobile_format check (mobile ~ '^01[3-9][0-9]{8}$'),
  constraint investors_photo_size check (photo is null or octet_length(photo) <= 2097152),
  constraint investors_nid_scan_size check (nid_scan is null or octet_length(nid_scan) <= 4194304),
  constraint investors_nid_hash_len check (nid_hash is null or length(nid_hash) = 64)
);

create unique index investors_mobile_unique on investors (mobile) where deleted_at is null;
create unique index investors_nid_hash_unique on investors (nid_hash) where nid_hash is not null and deleted_at is null;
create index investors_status_idx on investors (status) where deleted_at is null;
create index investors_name_search_idx on investors (lower(name));
create index investors_created_idx on investors (created_at desc);

create trigger investors_set_updated_at before update on investors
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- nominees (max 3 per investor + shares must total 100 - DB enforced)
-- ---------------------------------------------------------------------------
create table nominees (
  id            bigserial primary key,
  investor_id   bigint not null references investors(id) on delete cascade,
  name          varchar(120) not null,
  relation      varchar(60) not null,
  mobile        varchar(20) not null,
  nid_encrypted text,
  nid_hash      text,
  nid_last4     varchar(4),
  share_percent numeric(5,2) not null check (share_percent > 0 and share_percent <= 100),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint nominees_mobile_format check (mobile ~ '^01[3-9][0-9]{8}$')
);

create index nominees_investor_idx on nominees (investor_id);

create trigger nominees_set_updated_at before update on nominees
  for each row execute function set_updated_at();

-- Max 3 nominees per investor (immediate).
create or replace function enforce_nominee_limit() returns trigger
language plpgsql as $$
declare
  nominee_count integer;
begin
  select count(*) into nominee_count
    from nominees
   where investor_id = coalesce(new.investor_id, old.investor_id);
  if nominee_count > 3 then
    raise exception 'An investor can have at most 3 nominees (attempted %)', nominee_count
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;

create trigger nominees_max_three
  after insert or update of investor_id on nominees
  for each row execute function enforce_nominee_limit();

-- Nominee shares must total 100% for an investor that has any nominees.
-- Deferred so a multi-row rebalancing edit is allowed inside one transaction
-- (POST /nominees replaces the whole set in a single transaction).
create or replace function enforce_nominee_shares_total() returns trigger
language plpgsql as $$
declare
  target bigint := coalesce(new.investor_id, old.investor_id);
  total numeric(6,2);
  row_count integer;
begin
  select coalesce(sum(share_percent), 0), count(*) into total, row_count
    from nominees where investor_id = target;

  if row_count = 0 then
    return null;                -- investor without nominees is valid
  end if;
  if row_count > 3 then
    raise exception 'An investor can have at most 3 nominees (found %)', row_count using errcode = 'P0001';
  end if;
  if total <> 100 then
    raise exception 'Nominee shares for investor % must total 100%% (currently %)', target, total
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;

create constraint trigger nominees_shares_total
  after insert or update or delete on nominees
  deferrable initially deferred
  for each row execute function enforce_nominee_shares_total();

-- ---------------------------------------------------------------------------
-- investments
-- ---------------------------------------------------------------------------
create table investments (
  id                bigserial primary key,
  investor_id       bigint not null references investors(id) on delete restrict,
  title             varchar(160),
  total_amount      bigint not null check (total_amount > 0),   -- poisha
  installment_count integer not null check (installment_count between 1 and 120),
  interval          varchar(10) not null default 'MONTHLY' check (interval in ('MONTHLY', 'WEEKLY')),
  first_due_date    date,
  status            varchar(20) not null default 'ACTIVE'
                      check (status in ('ACTIVE', 'COMPLETED', 'CANCELLED')),
  notes             varchar(2000),
  created_by        bigint references admins(id) on delete set null,
  updated_by        bigint references admins(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index investments_investor_idx on investments (investor_id);
create index investments_status_idx on investments (status);
create index investments_created_idx on investments (created_at desc);

create trigger investments_set_updated_at before update on investments
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- installments
-- ---------------------------------------------------------------------------
create table installments (
  id               bigserial primary key,
  investment_id    bigint not null references investments(id) on delete cascade,
  serial           integer not null check (serial >= 1),
  amount           bigint not null check (amount > 0),          -- poisha
  amount_paid      bigint not null default 0 check (amount_paid >= 0),
  due_date         date not null,
  status           varchar(20) not null default 'PENDING'
                     check (status in ('PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WAIVED', 'CANCELLED')),
  pay_token_hash   text unique,
  token_expires_at timestamptz,
  token_issued_at  timestamptz,
  token_version    integer not null default 0,   -- bumped on regeneration
  last_reminded_at timestamptz,
  reminder_count   integer not null default 0,
  paid_at          timestamptz,
  status_reason    varchar(500),
  status_changed_by bigint references admins(id) on delete set null,
  status_changed_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint installments_amount_paid_within_amount check (amount_paid <= amount),
  constraint installments_investment_serial_unique unique (investment_id, serial)
);

create index installments_investment_idx on installments (investment_id, serial);
create index installments_status_idx on installments (status);
create index installments_due_date_idx on installments (due_date)
  where status in ('PENDING', 'PARTIALLY_PAID', 'OVERDUE');
create index installments_paid_at_idx on installments (paid_at) where paid_at is not null;
create index installments_token_idx on installments (pay_token_hash) where pay_token_hash is not null;

create trigger installments_set_updated_at before update on installments
  for each row execute function set_updated_at();

-- Invariant: the installments of an investment must sum to its total.
-- Deferred so create/edit operations can shuffle amounts inside one transaction.
create or replace function enforce_installment_sum() returns trigger
language plpgsql as $$
declare
  target bigint := coalesce(new.investment_id, old.investment_id);
  total bigint;
  expected bigint;
  rows_found integer;
begin
  select i.total_amount, i.installment_count into expected, rows_found from investments i where i.id = target;
  if expected is null then
    return null;  -- investment row gone (cascade delete)
  end if;
  select coalesce(sum(amount), 0), count(*) into total, rows_found from installments where investment_id = target;
  if rows_found > 0 and total <> expected then
    raise exception 'Installments of investment % must total % poisha (currently %)', target, expected, total
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;

create constraint trigger installments_sum_matches_investment
  after insert or update or delete on installments
  deferrable initially deferred
  for each row execute function enforce_installment_sum();

create or replace function enforce_investment_total_change() returns trigger
language plpgsql as $$
declare
  total bigint;
  rows_found integer;
begin
  if new.total_amount = old.total_amount then
    return new;
  end if;
  select coalesce(sum(amount), 0), count(*) into total, rows_found from installments where investment_id = new.id;
  if rows_found > 0 and total <> new.total_amount then
    raise exception 'Cannot change total: installments total % poisha', total using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create constraint trigger investments_total_matches_installments
  after update of total_amount on investments
  deferrable initially deferred
  for each row execute function enforce_investment_total_change();

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
create table payments (
  id                  bigserial primary key,
  installment_id      bigint not null references installments(id) on delete cascade,
  gateway             varchar(20) not null default 'BKASH' check (gateway in ('BKASH', 'MANUAL')),
  gateway_payment_id  varchar(80) unique,
  trx_id              varchar(80),
  invoice_number      varchar(80),
  amount              bigint not null check (amount > 0),        -- poisha
  status              varchar(20) not null default 'INITIATED'
                        check (status in ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED')),
  method              varchar(10) not null default 'BKASH' check (method in ('BKASH', 'CASH', 'BANK', 'OTHER')),
  gateway_status      varchar(60),
  manual_reference    varchar(120),
  reference_note      varchar(500),
  recorded_by_admin_id bigint references admins(id) on delete set null,
  payer_mobile        varchar(20),
  operation_id        varchar(40),
  check_count         integer not null default 0,
  raw_response        jsonb,
  failure_reason      varchar(500),
  initiated_at        timestamptz not null default now(),
  verified_at         timestamptz,
  paid_at             timestamptz,
  refunded_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint payments_manual_requires_reference
    check (method = 'BKASH' or (manual_reference is not null and length(btrim(manual_reference)) >= 3))
);

create index payments_installment_idx on payments (installment_id);
create index payments_status_idx on payments (status);
create index payments_created_idx on payments (created_at desc);
create index payments_method_idx on payments (method);
create index payments_paid_at_idx on payments (paid_at) where status = 'SUCCESS';
-- trxId must be unique per gateway when present (replay protection)
create unique index payments_gateway_trx_unique
  on payments (gateway, trx_id) where trx_id is not null;

create trigger payments_set_updated_at before update on payments
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- sms_logs
-- ---------------------------------------------------------------------------
create table sms_logs (
  id             bigserial primary key,
  installment_id bigint references installments(id) on delete set null,
  investor_id    bigint references investors(id) on delete set null,
  mobile_masked  varchar(20) not null,
  message_type   varchar(40) not null
                   check (message_type in ('PAYMENT_LINK', 'DUE_REMINDER', 'OVERDUE_REMINDER', 'PAYMENT_SUCCESS', 'RECEIPT', 'MANUAL', 'TEST')),
  provider       varchar(30) not null,
  provider_message_id varchar(120),
  provider_status varchar(30) not null default 'QUEUED',
  template_key   varchar(60),
  body_preview   varchar(160),
  error          varchar(300),
  sent_by_admin_id bigint references admins(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index sms_logs_installment_idx on sms_logs (installment_id);
create index sms_logs_created_idx on sms_logs (created_at desc);
create index sms_logs_type_idx on sms_logs (message_type);

create trigger sms_logs_set_updated_at before update on sms_logs
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- audit_logs  (append-only)
-- ---------------------------------------------------------------------------
create table audit_logs (
  id         bigserial primary key,
  admin_id   bigint references admins(id) on delete set null,
  actor_email varchar(254),      -- snapshot: survives admin deletion
  actor_role varchar(20),
  action     varchar(60) not null,
  entity     varchar(40) not null,
  entity_id  varchar(60),
  old_value  jsonb,
  new_value  jsonb,
  meta       jsonb,
  ip         inet,
  user_agent varchar(400),
  request_id varchar(60),
  created_at timestamptz not null default now()
);

create index audit_logs_created_idx on audit_logs (created_at desc);
create index audit_logs_entity_idx on audit_logs (entity, entity_id);
create index audit_logs_admin_idx on audit_logs (admin_id);
create index audit_logs_action_idx on audit_logs (action);

-- Append-only: no UPDATE, no DELETE, no TRUNCATE - ever.
create or replace function audit_logs_block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only (% is not permitted)', tg_op using errcode = 'P0001';
end;
$$;

create trigger audit_logs_no_update before update or delete on audit_logs
  for each row execute function audit_logs_block_mutation();
create trigger audit_logs_no_truncate before truncate on audit_logs
  for each statement execute function audit_logs_block_mutation();

-- ---------------------------------------------------------------------------
-- job_runs (in-process scheduler bookkeeping; makes jobs resumable/idempotent)
-- ---------------------------------------------------------------------------
create table job_runs (
  id           bigserial primary key,
  job_name     varchar(60) not null,
  run_key      varchar(60) not null,          -- e.g. the Dhaka date or window
  status       varchar(20) not null check (status in ('STARTED', 'SUCCESS', 'FAILED')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  duration_ms  integer,
  items_processed integer not null default 0,
  detail       jsonb,
  error        varchar(500),
  constraint job_runs_unique unique (job_name, run_key)
);

create index job_runs_job_idx on job_runs (job_name, started_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled everywhere, no policies anywhere.
-- Our server connects as the schema owner and therefore still works, while
-- Supabase's PostgREST / anon / authenticated roles can read nothing.
-- ---------------------------------------------------------------------------
alter table admins       enable row level security;
alter table sessions     enable row level security;
alter table investors    enable row level security;
alter table nominees     enable row level security;
alter table investments  enable row level security;
alter table installments enable row level security;
alter table payments     enable row level security;
alter table sms_logs     enable row level security;
alter table audit_logs   enable row level security;
alter table job_runs     enable row level security;
alter table schema_migrations enable row level security;
