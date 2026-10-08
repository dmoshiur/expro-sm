-- 003_auth_extras.sql
-- TOTP replay protection + admin 2FA bookkeeping.
alter table admins add column if not exists totp_last_step bigint;
alter table admins add column if not exists totp_confirmed_at timestamptz;
alter table admins add column if not exists password_changed_at timestamptz;
alter table admins add column if not exists disabled_reason varchar(300);

create index if not exists admins_locked_idx on admins (locked_until) where locked_until is not null;

-- Sessions: keep a hash chain so a stolen rotated token is detectable.
alter table sessions add column if not exists rotated_to uuid;
alter table sessions add column if not exists revoked_reason varchar(60);
create index if not exists sessions_token_hash_idx on sessions (token_hash);
