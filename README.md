# Investor Installment Portal

An admin-only portal for collecting investment installments in Bangladesh:
investors and nominees, auto-split installment schedules, SMS payment links,
bKash payments, manual (cash/bank) entries, receipts, reports and a full audit
trail.

One repository, **one Node process**: Express serves the built React SPA from
`client/dist` *and* the `/api` on the same port, so there is no CORS in
production and nothing else to deploy (no Redis, no queue, no cron, no Docker).

```
.
├── README.md                        ← this file
└── investor-portal/                 ← the application
    ├── package.json                 ← server + client scripts, dependency whitelist
    ├── .env.example                 ← every supported environment variable
    ├── client/                      ← React SPA (Vite, plain CSS, no UI libraries)
    ├── server/                      ← Express API, migrations, jobs, tests
    ├── scripts/                     ← dev runner, environment checker
    └── docs/
        ├── permissions.md           ← role matrix per endpoint
        └── payment-flow.md          ← link + bKash state machine
```

## Requirements

* **Node.js ≥ 22** (no build step for the server; uses `--env-file`, `--test`,
  `node:test`, global `fetch`, `node:crypto`).
* **PostgreSQL ≥ 14** (Docker, a local install, or Supabase).
* Runtime dependencies: `express` and `pg`. Client libraries: `react`,
  `react-dom`, `react-router-dom`, `vite`, `@vitejs/plugin-react`. Nothing else.
* Node's built-in SQL-free tooling is used for everything else: password
  hashing (scrypt), sessions (HMAC + httpOnly cookie), 2FA (TOTP RFC 6238),
  AES-256-GCM field encryption, validation, rate limiting, CSV/HTML rendering,
  scheduling (`setInterval`), tests (`node:test`).

## Quick start (local)

```bash
git clone <this repo> && cd expro-sm/investor-portal
npm install                                   # installs workspaces: server + client

cp .env.example .env
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
#   → paste both into .env, then set DATABASE_URL

npm run check      # validates env, DB reachability and migration state
npm run migrate    # applies server/src/db/migrations/*.sql in order
npm run seed       # first SUPER_ADMIN (+ sample data; see --no-sample)
npm run build      # builds the SPA into client/dist
npm start          # http://localhost:3000  (API + SPA, one process)
```

Development with auto-reload (server via `node --watch`, Vite dev server with an
`/api` proxy):

```bash
npm run dev        # alias of node scripts/dev.mjs
```

Seed credentials (override with `SEED_*` variables, change on first login):

| Role | Email | Password |
| --- | --- | --- |
| Super Admin | `superadmin@investorportal.test` | `Portal#Root#2026!` |
| Accountant | `accountant@investorportal.test` | `Portal#Ledger#2026!` |
| Viewer | `viewer@investorportal.test` | `Portal#Reports#2026!` |

Every seeded admin starts with `must_change_password = true`; the portal forces
a password change before anything else, and password policy rejects common
passwords and anything containing the admin's own name or email local part.

## Configuration (`.env`)

`server/src/config/index.js` reads the environment **once at startup** and
refuses to boot when a required value is missing or malformed. `npm run check`
does the same checks without starting the server.

| Group | Keys | Notes |
| --- | --- | --- |
| Runtime | `NODE_ENV`, `PORT`, `BIND_HOST`, `LOG_LEVEL`, `PUBLIC_BASE_URL` | `BIND_HOST=0.0.0.0`; `PUBLIC_BASE_URL` builds payment links and the bKash callback |
| Database | `DATABASE_URL`, `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED`, `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS` | `DB_SSL=auto` turns TLS on for any non-localhost host |
| Secrets | `SESSION_SECRET` (≥32 chars), `ENCRYPTION_KEY` (64 hex chars) | rotating `ENCRYPTION_KEY` makes stored NID/TOTP ciphertext unreadable |
| Sessions | `SESSION_TTL_HOURS`, `SESSION_ROTATE_AFTER_MINUTES`, `COOKIE_SECURE`, `COOKIE_NAME`, `ALLOWED_ORIGINS`, `TRUST_PROXY` | cookies are `httpOnly`, `SameSite=Strict`, and `Secure` when `NODE_ENV=production` |
| Lockout/limits | `ADMIN_LOCKOUT_THRESHOLD`, `ADMIN_LOCKOUT_MINUTES`, `RATE_LIMIT_*` | in-memory fixed-window limiters, per process |
| Payment links | `PAYMENT_LINK_TTL_DAYS` | default 30 |
| Payments | `PAYMENT_PROVIDER`, `BKASH_*`, `PAYMENTS_WEBHOOK_ENABLED`, `PAYMENTS_WEBHOOK_SECRET`, `RECONCILE_STUCK_AFTER_MINUTES` | `PAYMENT_PROVIDER=mock` runs the whole flow offline |
| SMS | `SMS_PROVIDER` (`console`\|`bulksmsbd`\|`generic`), `SMS_API_URL`, `SMS_API_KEY`, `SMS_SENDER_ID`, `SMS_DRY_RUN` | `console` logs masked messages instead of sending |
| Jobs | `JOBS_ENABLED`, `JOB_OVERDUE_AT`, `JOB_REMINDERS_AT`, `JOB_RECONCILE_EVERY_MINUTES`, `REMINDER_DAYS_BEFORE`, `OVERDUE_REMINDER_INTERVAL_HOURS` | times are Asia/Dhaka (UTC+6, no DST) |
| Misc | `TOTP_ISSUER`, `TOTP_WINDOW`, `MAX_UPLOAD_BYTES`, `MASK_LOGS` | `TOTP_ISSUER` is also the business name printed on the public pay page and receipts |

Uploads: investor photos are ≤ `MAX_UPLOAD_BYTES` (default 2 MiB, JPEG/PNG) and
NID scans ≤ 4 MiB (JPEG/PNG/PDF). File types are decided by magic bytes, not by
extension or `Content-Type`. Nothing uploaded is ever served from a static
folder: bytes live in the database, the NID scan is encrypted, and reads go
through permission-checked routes that audit every access.

## Supabase (managed PostgreSQL)

1. Create the project, then **Project Settings → Database → Connection string →
   URI**. Use the *connection pooler* host for the app: it survives IPv4/IPv6
   and connection recycling better than the direct host.
2. Append `?sslmode=require` (and keep `DB_SSL=auto`,
   `DB_SSL_REJECT_UNAUTHORIZED=false` unless you pin the CA).
3. Put it in `.env` as `DATABASE_URL` and run `npm run migrate` followed by
   `npm run seed` (the seed's first-run branch only creates the initial admins).

```env
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require
```

Row Level Security is enabled on every table with **no policies**, so
PostgREST/anon keys cannot read anything; the app connects as the table owner
and bypasses RLS by design. All application access goes through the API, which
enforces the role matrix in [docs/permissions.md](investor-portal/docs/permissions.md).

## Migrations

Numbered SQL files in `server/src/db/migrations/` are applied in filename order
and recorded in `schema_migrations` with a checksum. Editing an applied file
fails the drift guard — add a new `004_*.sql` instead.

```bash
npm run migrate              # apply pending migrations
npm run migrate -- --dry-run # show what would be applied, touch nothing
```

The server also applies pending migrations at boot unless `RUN_MIGRATIONS_ON_START=false`.
Deploy order is therefore: `npm ci && npm run build`, restart, done.

## bKash

Sandbox first — see [docs/payment-flow.md](investor-portal/docs/payment-flow.md)
for the full state machine and the security rules.

```env
PAYMENT_PROVIDER=bkash
BKASH_MODE=sandbox
BKASH_BASE_URL=https://tokenized.sandbox.bka.sh/v1.2.0-beta
BKASH_APP_KEY=… BKASH_APP_SECRET=… BKASH_USERNAME=… BKASH_PASSWORD=…
PUBLIC_BASE_URL=https://portal.example.com     # HTTPS and publicly reachable
```

Create the credentials in the bKash developer portal, whitelist the callback URL
(`https://portal.example.com/pay/callback`), and run one sandbox payment
end-to-end before switching `BKASH_MODE=live` with live credentials. If you
configure a webhook at bKash, set `PAYMENTS_WEBHOOK_ENABLED=true` and
`PAYMENTS_WEBHOOK_SECRET` and point it at `POST /api/payments/webhook` — it is
optional, the callback plus the reconciliation job are the source of truth.

SMS: set `SMS_PROVIDER=bulksmsbd` (or `generic` with `SMS_API_URL`) and
`SMS_DRY_RUN=false`. Messages are always logged with a masked recipient, and the
payment-page projection never contains more than the investor's first name.

## VPS deployment (single process + systemd + HTTPS reverse proxy)

```bash
# one-time
sudo adduser --system --group --home /srv/investor-portal portal
sudo -u portal git clone <this repo> /srv/investor-portal
cd /srv/investor-portal/investor-portal
sudo -u portal npm ci                 # full install: vite/react are needed to build
sudo -u portal npm run build          # writes client/dist
sudo -u portal cp .env.example .env   # then fill it in (chmod 600)
sudo -u portal npm run check && sudo -u portal npm run migrate
```

`/etc/systemd/system/investor-portal.service`:

```ini
[Unit]
Description=Investor Installment Portal
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=portal
Group=portal
WorkingDirectory=/srv/investor-portal/investor-portal
EnvironmentFile=/srv/investor-portal/investor-portal/.env
ExecStart=/usr/bin/node server/server.js
Restart=always
RestartSec=5
# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/srv/investor-portal

[Install]
WantedBy=multi-user.target
```

`sudo systemctl daemon-reload && sudo systemctl enable --now investor-portal`

nginx (TLS via certbot; the SPA and API share the origin, so only one site):

```nginx
server {
  listen 443 ssl http2;
  server_name portal.example.com;
  ssl_certificate     /etc/letsencrypt/live/portal.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/portal.example.com/privkey.pem;

  client_max_body_size 6m;              # NID scans are up to 4 MiB
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
server { listen 80; server_name portal.example.com; return 301 https://$host$request_uri; }
```

Set `TRUST_PROXY=1` (already the default) so `req.ip`, the rate limiters and the
audit log see the real client address, and `COOKIE_SECURE=true` (forced when
`NODE_ENV=production`). Health check: `GET /api/health` returns the DB
round-trip and scheduler state without leaking anything.

### Backups (pg_dump / pg_restore)

```bash
# nightly dump (keep 14 days) — add to the host crontab, not to the app
pg_dump "$DATABASE_URL" --format=custom --no-owner --file="/var/backups/portal-$(date +%F).dump"
find /var/backups -name 'portal-*.dump' -mtime +14 -delete

# restore into a fresh database
createdb portal_restore
pg_restore --no-owner --dbname "$RESTORE_URL" /var/backups/portal-2026-10-08.dump
```

`audit_logs` is append-only (a database trigger rejects UPDATE/DELETE/TRUNCATE),
so never restore with `--clean` against a live database and never use `TRUNCATE`
on it: reset a database by recreating the schema instead.

## Testing

```bash
createdb investor_portal_test        # a separate database, never the live one
cp .env .env.test                    # then point it at the test database:
#   DATABASE_URL=postgres://postgres@127.0.0.1:5432/investor_portal_test
#   NODE_ENV=test
npm test                             # unit + integration tests
npm run test:unit                    # fast, no database needed
```

The harness (`server/tests/helpers/harness.js`) loads `.env` and then overlays
`.env.test` **before** any application module is imported, and refuses to run if
the resolved `DATABASE_URL` does not point at a database whose name contains
`test`. It then recreates the schema, applies migrations, boots the real Express
app on an ephemeral port, and swaps the bKash gateway and the SMS provider for
in-process fakes (both sit behind `setGateway()` / `setSmsProvider()` seams, so
no test touches the network). Covered:
installment split/remainder maths, sum invariants, link hashing/expiry/
regeneration, RFC 6238 TOTP vectors, password policy, AES-GCM round-trips,
RBAC on every admin route, NID masking and encryption, upload magic bytes,
nominee limits and share totals, the full payment flow (success, tampering,
amount mismatch, duplicate trx, cancel, reconciliation), manual payments and
their reversal, receipts, reports/CSV, jobs and reminders.

## Assumptions

* **Investors never log in** in this version. Their only interface is the
  SMS payment link (`/pay/<token>`), which shows the first name, installment
  number, amount and due date — nothing else.
* **One live payment link per installment.** Re-issuing (manually, by a bulk
  send, or from the reminder job) invalidates the previous URL, because only the
  SHA-256 hash is stored and an old URL can therefore never be recovered.
* **Money is a whole number of poisha** (`bigint`), BDT only. Split installments
  use floor division and the remainder is added to the **last** installment, so
  the sum always equals the investment total exactly.
* **Partial payments are manual only.** bKash settles the full outstanding
  amount for the link; cash/bank entries can be partial and may be voided by an
  accountant with a reason (the reversal is audited).
* **A settled bKash payment cannot be voided in the portal.** Refund it in the
  bKash panel and record the adjustment as a manual entry.
* **Scheduling is in-process** (`setInterval`/`setTimeout`, Asia/Dhaka). A
  restart catches up on missed work because runs are keyed by day/window with a
  `job_runs` claim row; `JOBS_ENABLED=false` keeps the API but stops the ticker
  (useful for maintenance or when running a read-only replica of the process).
* **Reminders are best-effort anti-spam**, not guaranteed-delivery: at most
  100 per run and one message per installment per
  `OVERDUE_REMINDER_INTERVAL_HOURS` (default 72h).
* **Audit history is immutable.** Nothing in the application can delete or edit
  an audit row, which also means there is no "purge" button — plan storage
  accordingly.
* **Local uploads live in PostgreSQL** (`bytea`), so the database backup *is*
  the document backup. NID scans are stored AES-256-GCM encrypted and readable
  by a Super Admin only.
* **Rate limiting is per process and in-memory**, deliberately: one process,
  no Redis. With several instances the effective limits multiply.
* **No multi-currency, no investor-facing statements, no email, no refunds
  workflow, no PDF generation** (receipts and reports are printable HTML with
  `@media print`, so "save as PDF" is the browser's job).
* The console SMS provider writes masked messages to the log; it is a
  development aid, not a delivery mechanism.
