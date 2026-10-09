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
* **Turso/libSQL** (remote Turso in production; disposable local libSQL files for tests/dev).
* Runtime dependencies: `express` and `@libsql/client`. Client libraries: `react`,
  `react-dom`, `react-router-dom`, `vite`, `@vitejs/plugin-react`. Nothing else.
* Node's built-in SQL-free tooling is used for everything else: password
  hashing (scrypt), sessions (HMAC + httpOnly cookie), 2FA (TOTP RFC 6238),
  AES-256-GCM field encryption, validation, rate limiting, CSV/HTML rendering,
  scheduling (`setInterval`), tests (`node:test`).

## Quick start (local)

```bash
git clone <this repo> && cd expro-sm
npm install                                   # installs workspaces: server + client

cp .env.example .env
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
#   → paste both into .env, then set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN

npm run migrate    # applies server/src/db/migrations/*.sql in order
npm run db:check   # verifies migration state and invariants
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
| Database | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `DB_MIGRATE_ON_START` | Remote Turso required in production; no PostgreSQL or localhost DB fallback |
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

## Turso setup

The application uses `@libsql/client` exclusively. Create a Turso database and
store its URL (`libsql://<database>-<org>.turso.io`) and auth token as
`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Production rejects file, in-memory,
PostgreSQL, HTTP and localhost database URLs. No PostgreSQL service is needed;
`tools/pg-to-turso/` contains only optional one-time import tools/reference SQL.

Local development can use `NODE_ENV=development` and a `file:` URL. Tests use
isolated files through the same libSQL client, not a localhost database server.

## Migrations

Numbered SQL files in `server/src/db/migrations/` are applied in filename order
and recorded in `schema_migrations` with a SHA-256 checksum. Each file's SQL and
history row commit in one write transaction. Failed files roll back, stop the
run, and remain pending. Previously committed files are skipped on retry.
Never edit an applied file; add a new numbered migration instead.

```bash
npm run migrate              # create/validate metadata, then apply all pending SQL
npm run migrate -- --dry-run # read-only checksum/pending check; no tables created
npm run db:check             # migration status, then FK/invariant checks
```

The runner creates `schema_migrations` idempotently before reading it on an apply
run. Verify-only mode recognizes a fresh empty database without querying a
nonexistent table. Incompatible metadata or existing application tables without
history are refused, not automatically baselined. Such cases need operator
schema/history review; see [docs/database.md](docs/database.md).

Production defaults to `DB_MIGRATE_ON_START=false`: the server refuses to listen
with pending migrations or checksum drift. Dev defaults to true. The explicit
production deployment order is build → migrate → start; opting into
`DB_MIGRATE_ON_START=true` runs the same runner before listening.

## Render deployment / redeployment

Use the repository root (leave Render **Root Directory** blank), Node ≥22.9,
and these commands (also encoded in `render.yaml`):

* **Build Command:** `npm ci && npm run build`
  * `npm ci` installs all workspaces (server + client). `npm run build`
    builds the React SPA with Vite into `client/dist` and then runs
    `scripts/verify-build.mjs`, which fails the build with a clear error if
    `client/dist/index.html` or the hashed assets are missing (instead of
    silently deploying a 503 frontend). The build needs `vite` and
    `@vitejs/plugin-react` — they are `devDependencies` at the repository root,
    so the build must run with `NPM_CONFIG_PRODUCTION=false` (the default for
    `npm ci`; do not run `npm ci --production` / `--omit=dev` before the build).
* **Pre-Deploy Command** (if available): `npm run migrate`
* **Start Command:** `npm start`
* If a pre-deploy command is unavailable, use **Start Command**:
  `npm run migrate && npm start` (the `&&` must remain).
* **Health Check Path:** `/api/health` (returns 200 only when the Turso
  database answers `SELECT 1`; never leaks URLs or tokens).

The Express server serves `client/dist` from an absolute path
(`server/src/app.js:CLIENT_DIST = resolve(../../client/dist)`) and falls back
to `index.html` for SPA routes. `/` serves the built frontend (200) after a
successful build; `/favicon.ico` serves the real `favicon.ico` from the build
or a proper 404 — it never triggers a 503. `/api/*` is never swallowed by the
fallback, and unknown JSON routes return `{ error: { code: 'NOT_FOUND' } }`.

Required Render environment variables (`render.yaml` marks them `sync: false`
so the dashboard is the source of truth):

| Required | Key | Example / Notes |
|----------|-----|-----------------|
| **yes** | `NODE_ENV` | `production` (enables secure cookies, HSTS, `https` check on `PUBLIC_BASE_URL`) |
| **yes** | `TURSO_DATABASE_URL` | `libsql://…-….turso.io` (remote Turso only; `file:` rejected in prod) |
| **yes** | `TURSO_AUTH_TOKEN` | `turso db tokens create <db>` — secret |
| **yes** | `SESSION_SECRET` | `≥32 chars`, `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| **yes** | `ENCRYPTION_KEY` | `64 hex chars (32 bytes)`, `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — rotation invalidates stored NID/TOTP ciphertext |
| **yes** | `PUBLIC_BASE_URL` | `https://expro-sm.onrender.com` (must be `https` in prod; used for payment links & callbacks) |
| auto | `PORT` | Supplied by Render (default 10000); `BIND_HOST=0.0.0.0` is already the default |
| auto | `TRUST_PROXY` | `1` (already default; needed for `req.ip` behind Render's proxy) |

Optional (defaults shown; set explicitly if you need live providers):

| Key | Default | Notes |
|-----|---------|-------|
| `PAYMENT_PROVIDER` | `mock` | **Mock is test-only** — it simulates bKash without network and must not be used for real money. Set to `bkash` for live payments and provide `BKASH_*`. Server logs `paymentProvider` at startup; with `mock` in production it warns. |
| `SMS_PROVIDER` | `console` | `console` logs masked messages, does not send. Real `bulksmsbd`/`generic` requires `SMS_API_URL`/`SMS_API_KEY` and `SMS_DRY_RUN=false`. |
| `DB_MIGRATE_ON_START` | `false` in prod (`true` in dev) | Keep `false` and run `npm run migrate` explicitly (see commands above). |
| `LOG_LEVEL` | `info` |  |
| `NPM_CONFIG_PRODUCTION` | `false` | Keep `false` for the Build Command so `vite` is available. |

Copy `.env.example` to `.env` for local development (use a `file:` Turso URL there). Do not deploy a `.env` file to Render.

Redeploy the revision containing this fix. On a fresh database expect
`migration applied` for `001_turso_initial_schema.sql`, then `migrations complete`,
`database connected`, the read-only foreign-key probe (`database foreign keys`), and
`investor portal listening` with `env: production`, `publicBaseUrl: https://…`,
`paymentProvider` and `smsProvider`. On subsequent deploys the initial migration
is skipped. Run `npm run db:check` in the Render shell after migration: pending
migrations must be zero and both invariant mismatch counts must be zero. Run
`npm run verify:deploy` locally (`node scripts/verify-deploy.mjs`) to check
the build, the Turso connection, session handling, `/` (200), `/favicon.ico`
(200 or 404, never 503), `/api/health`, SPA fallback and auth wiring.
Do not run a reset, import, or sample seed as part of repair. If migration
reports incompatible/untracked schema, stop and follow the operator-review
guidance in `docs/database.md` rather than editing history.

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
