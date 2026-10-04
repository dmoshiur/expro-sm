# Investor Installment Portal

An admin-only platform for collecting **investor installments** in Bangladesh. Staff create an
investor, split an investment into a schedule of installments, and send each installment a unique
secure payment link by SMS. The investor opens the link (no account, no login), pays with **bKash**,
and the server verifies the transaction with the gateway before marking the installment paid.
Everything is recorded in an append-only audit trail.

```
Admin UI (React SPA)  ──HTTPS──▶  Express API  ──Prisma──▶  PostgreSQL (Supabase)
        │                              │
        │                              ├── bKash Tokenized Checkout (sandbox / live)
        │                              ├── SMS gateway (local BD provider or console)
        └── /pay/:token public page ───┴── Cloudinary (photos public, NID private)
```

## Highlights

| Area | What it does |
| --- | --- |
| Investors | CRUD, search / filter / sort / paginate, photo, optional NID scan (encrypted + private), 1–3 nominees with shares that must total 100 %, soft delete |
| Investments | Auto-split into N installments (integer **poisha**, remainder on the **last** installment), sum is validated by a deferred DB constraint, editable before payment, waive / cancel / reopen with reason |
| Payment links | 32-byte random token, only the SHA-256 hash stored, configurable expiry, regeneration invalidates the old link, sent by SMS (single + bulk) with a delivery log |
| Payments | bKash Tokenized Checkout behind a gateway adapter, atomic settlement, idempotent callbacks, duplicate-transaction-id rejection, reconciliation cron, optional webhook, manual cash / bank entries |
| Receipts | PDF receipt per successful payment (`pdfkit`), receipt numbers `RC-YYYYMM-XXXXXX` |
| Dashboard | Invested / collected / outstanding / overdue, today's and month-to-date collection, 12-month trend chart, upcoming installments, recent payments |
| Reports | Due & overdue book, collection register, investor statement — screen + **Excel (OOXML, `exceljs`)** + **PDF** export, all exports audited |
| Reminders | Daily cron (Asia/Dhaka): due-in-N-days and overdue SMS, deduplicated via `lastRemindedAt`, re-notify window for overdue |
| Security | JWT in httpOnly + Secure + SameSite cookies with refresh rotation, argon2id, optional TOTP 2FA, account lockout, strict CORS, helmet, per-route rate limits, Zod on every route, AES-256-GCM for NID and 2FA secrets, masked PII in logs, request IDs |
| Audit | Service-layer audit log with old/new values; DB trigger blocks `UPDATE`/`DELETE` on `audit_logs`; only read endpoints exist |
| RBAC | SUPER_ADMIN / ACCOUNTANT / VIEWER enforced by middleware — see `docs/permissions.md` |

## Monorepo layout

```
investor-portal/
├── server/                      # Express + TypeScript API
│   ├── src/
│   │   ├── config/              # env schema + Prisma client (pg driver adapter)
│   │   ├── controllers/         # HTTP layer (thin)
│   │   ├── routes/              # route tables + validation wiring
│   │   ├── middleware/          # auth, RBAC, CSRF, rate limits, upload, errors
│   │   ├── services/            # business logic (auth, investor, installment, payment, sms, receipt, report, audit, settings, dashboard, storage)
│   │   ├── jobs/                # node-cron scheduler (Asia/Dhaka) + swappable interface
│   │   ├── validators/          # Zod schemas
│   │   └── utils/               # money (poisha), dates (Dhaka), errors, encryption, permissions
│   ├── prisma/                  # schema, SQL migration (RLS + triggers), seed
│   ├── scripts/                 # prisma launcher, migration applier, db reset
│   ├── tests/                   # Vitest + Supertest (136 tests)
│   └── server.ts                # bootstrap
├── client/                      # React + Vite + TS SPA (Tailwind, TanStack Query, RHF + Zod)
│   └── src/{pages,components,services,store,hooks,lib}
├── deploy/                      # Nginx, PM2, backup scripts
├── docs/                        # permissions, payment flow, OpenAPI, Postman
└── scripts/local-postgres.sh    # zero-install local PostgreSQL for development
```

## Requirements

* Node.js **20+** (developed on 22) and npm 10+
* PostgreSQL **16** — either [Supabase](https://supabase.com) or the bundled local server
* Optional: Cloudinary account (file storage), bKash sandbox credentials, SMS gateway account

## Quick start (local, 5 minutes)

```bash
git clone <repo> && cd investor-portal
npm install                      # installs workspaces; prisma client generation is non-fatal here

cp server/.env.example server/.env
cp client/.env.example client/.env

./scripts/local-postgres.sh start          # downloads a pinned PostgreSQL 16 build (no root needed)
                                            # creates investor_portal + investor_portal_test
npm --workspace server run migrate:deploy  # applies prisma/migrations (RLS, triggers, constraints)
npm --workspace server run seed            # creates the first SUPER_ADMIN + default settings

npm run dev                                # API on :4000, SPA on :5173 (Vite proxies /api)
```

The seed prints the initial super-admin credentials exactly once:

```
email:    admin@investorportal.local      (override with SEED_ADMIN_EMAIL)
password: Admin@12345                     (override with SEED_ADMIN_PASSWORD)
```

> Change the password immediately after the first sign-in, and enable 2FA from **Profile**.

### Demo data

```bash
npm --workspace server run seed:demo       # 6 investors, investments, some paid installments
```

## Environment variables

`server/.env` (see `server/.env.example` for the full annotated list):

| Variable | Purpose |
| --- | --- |
| `NODE_ENV`, `PORT`, `APP_BASE_URL` | runtime mode, API port, public SPA base URL (used in SMS links and callback redirects) |
| `DATABASE_URL`, `DIRECT_URL` | Supabase **pooler (6543)** for the app, **direct (5432)** for migrations |
| `TEST_DATABASE_URL` | database used by the Vitest suite (reset on every run) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` | token signing and lifetimes (access 15 m, refresh 30 d by default) |
| `COOKIE_DOMAIN`, `COOKIE_SECURE` | cookie scoping (`secure` forced on in production) |
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM (NID numbers, TOTP secrets) — **rotating it invalidates stored NIDs/2FA secrets** |
| `CORS_ORIGINS` | comma-separated allowlist (strict; anything else is rejected with 403) |
| `RATE_LIMIT_DISABLED` | set to `1` in CI only |
| `BKASH_MODE`, `BKASH_BASE_URL`, `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_USERNAME`, `BKASH_PASSWORD`, `BKASH_CALLBACK_URL`, `BKASH_WEBHOOK_ENABLED`, `BKASH_WEBHOOK_SECRET` | bKash Tokenized Checkout. Without credentials the deterministic **mock gateway** is used, so development and tests work offline |
| `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_API_URL`, `SMS_SENDER_ID` | `console` (dev, prints + keeps an in-memory outbox), `bulksmsbd`, `alpha` |
| `STORAGE_DRIVER`, `LOCAL_STORAGE_DIR`, `CLOUDINARY_*` | `auto` uses Cloudinary when configured, otherwise local disk |
| `PAYMENT_LINK_TTL_DAYS`, `REMINDER_DAYS_BEFORE`, `REMINDER_ENABLED` | defaults; super admins can override the first two in **Settings** |
| `CRON_TIMEZONE`, `CRON_OVERDUE_MARK`, `CRON_REMINDERS`, `CRON_RECONCILE`, `CRON_TOKEN_CLEANUP` | cron expressions (all evaluated in Asia/Dhaka) |
| `RUN_JOBS` | `true` (default) starts the cron jobs in this process; set to `false` on every extra instance when scaling out |
| `COMPANY_NAME`, `SUPPORT_MOBILE`, `RECEIPT_PREFIX` | branding on the public page, SMS and receipts |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_DEMO` | seed script inputs |

`client/.env` only needs `VITE_API_BASE_URL` (leave empty in development to use the Vite proxy).

## Supabase setup

1. Create a project, then copy the two connection strings from **Project settings → Database**:
   * **Connection pooling** (port `6543`, `?pgbouncer=true`) → `DATABASE_URL`
   * **Direct connection** (port `5432`) → `DIRECT_URL`
2. Apply the migrations:

   ```bash
   npm --workspace server run migrate:deploy      # uses DIRECT_URL for DDL
   ```

   The migration enables **Row Level Security on every table with no policies**, so the
   `anon` / `authenticated` PostgREST roles cannot read anything even if the anon key leaks.
   The application connects as the database owner and is therefore not subject to RLS.
3. Nothing else is required: the backend talks to PostgreSQL through Prisma only. There is **no
   Supabase Auth, Realtime or client SDK** anywhere in the codebase, and the client never talks to
   the database directly.

> **Constraint note.** Both `migrations/…/migration.sql` and the Prisma schema carry the checks:
> installment sums must equal the investment total *and* the installment count (deferred
> constraint triggers), nominees ≤ 3, nominee shares total 100 %, `payments(gateway, trx_id)` is
> unique when a transaction id exists, `investors.nid_hash` is unique, and `audit_logs` blocks
> `UPDATE`/`DELETE`.

## Cloudinary setup

1. Add the cloud name, API key and API secret to `server/.env`.
2. Photo uploads are stored as **public** assets in `CLOUDINARY_UPLOAD_FOLDER`.
3. NID scans use `type: private` and are only ever served through short-lived signed URLs
   (`GET /api/investors/:id/nid-scan-url`, super-admin only, audited). Only the `public_id` is
   persisted — never the file itself or a public URL.
4. Uploads are validated server-side (JPG/PNG magic bytes, ≤ 2 MB) and streamed by the API.
5. Development without Cloudinary: `STORAGE_DRIVER=auto` falls back to local disk and serves files
   through the authenticated `/api/files` route.

## bKash sandbox

1. Register a sandbox merchant at <https://developer.bka.sh> and collect the app key/secret,
   username and password.
2. Set `BKASH_MODE=sandbox`, the credentials, and `BKASH_CALLBACK_URL` to
   `https://<your-host>/api/public/payments/bkash/callback`.
3. Leave `BKASH_WEBHOOK_ENABLED=false` unless bKash has enabled webhooks for your merchant —
   the reconciliation cron already covers lost callbacks.
4. Pay with a bKash sandbox wallet and confirm the installment flips to **PAID** with a receipt.

Without credentials the API boots with the **mock gateway**: `startPayment` returns a redirect URL to
the callback itself, and `mockGatewayControl` (test helper) can script completed / failed /
cancelled / amount-mismatch outcomes. All 136 tests run against this mock.

## Database migrations

| Command | What it does |
| --- | --- |
| `npm --workspace server run migrate:deploy` | applies pending migrations (production) |
| `npm --workspace server run migrate:dev` | `prisma migrate dev` for authoring new migrations |
| `npm --workspace server run migrate:status` | shows migration state |
| `node scripts/apply-migrations.mjs` | offline applier (no engine binaries required) used in restricted environments |
| `npm --workspace server run db:reset` | drops the schema and re-applies every migration (destructive, dev only) |
| `npm --workspace server run prisma:generate` | regenerates the Prisma client |

## Tests

```bash
npm test                       # server: resets investor_portal_test then runs Vitest (136 tests)
npm --workspace server run test:watch
npm run typecheck              # both workspaces
npm run lint                   # both workspaces
npm run build                  # server tsc + client vite build
```

The suite covers installment splitting and remainder, sum validation, token hashing / expiry /
regeneration, RBAC on **every** admin route (401 / 403 matrix incl. PII masking), duplicate
callbacks, duplicate transaction ids, cancelled and failed payments, amount mismatch, the
reconciliation job, the overdue-marker and token-cleanup jobs (Dhaka day boundary), manual payments
and receipts, reminders and dedupe, settings, audit writes, the nominee limit of three, and the
append-only audit trigger.

## Deployment (VPS: Nginx + PM2 + HTTPS)

```bash
# 1. server
sudo apt install -y nginx postgresql-client
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2

# 2. code + build
cd /var/www && git clone <repo> investor-portal && cd investor-portal
npm ci
npm --workspace server run prisma:generate
npm --workspace server run migrate:deploy
npm run build
cp server/.env.example server/.env    # fill in production values (COOKIE_SECURE=true, real secrets)

# 3. process manager
cp deploy/ecosystem.config.cjs.example deploy/ecosystem.config.cjs
pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup
pm2 logs investor-portal-api
```

`deploy/nginx.conf.sample` serves the built SPA from `client/dist`, proxies `/api` to the API on
`:4000`, adds HSTS/security headers, and gzips JSON. Enable TLS with certbot:

```bash
sudo cp deploy/nginx.conf.sample /etc/nginx/sites-available/investor-portal
sudo ln -s /etc/nginx/sites-available/investor-portal /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d portal.example.com --redirect
```

Checklist before going live:

* `NODE_ENV=production`, `COOKIE_SECURE=true`, real `JWT_*`/`ENCRYPTION_KEY` secrets (32-byte random)
* `CORS_ORIGINS=https://portal.example.com`
* `APP_BASE_URL=https://portal.example.com` (SMS links + gateway redirects)
* Cloudinary credentials set; bKash switched from `sandbox` to `live`
* Cron jobs run **inside** the API process (node-cron, Asia/Dhaka). Keep exactly **one** PM2 instance
  in `fork` mode with `RUN_JOBS=true`; if you must scale out, set `RUN_JOBS=false` on the extra
  instances so each job still runs exactly once (or move to `pg-boss`, see below)
* Daily `pg_dump` backup scheduled (see below) and a restore rehearsed at least once

### In-process jobs

| Job | Default schedule (Asia/Dhaka) | Purpose |
| --- | --- | --- |
| `overdue-installments` | `5 0 * * *` | flips unpaid installments past their due date to OVERDUE |
| `reminders` | `0 9 * * *` | due-in-N-days and overdue SMS (deduplicated) |
| `reconcile-payments` | `*/15 * * * *` | re-queries stuck INITIATED/PENDING bKash payments and settles them |
| `token-cleanup` | `30 2 * * *` | expires old payment links, prunes SMS logs and refresh tokens |

`src/jobs/scheduler.ts` hides the cron implementation behind a `Scheduler` interface, so swapping to
`pg-boss` (or any queue) means implementing that interface and changing one line — job definitions
stay untouched.

## Backups

```bash
# backup (cron: 02:15 daily)
PGPASSWORD=... pg_dump -h <supabase-host> -p 5432 -U postgres -d postgres \
  -F custom -f /var/backups/investor-portal-$(date +%F).dump

# restore (staging rehearsal)
pg_restore --clean --if-exists -d postgres /var/backups/investor-portal-2026-10-04.dump
```

`deploy/backup.sh` wraps the dump with retention (14 daily / 8 weekly files) and checksums.
Supabase also takes managed snapshots — keep the logical dump as an independent copy, and store it
off the database host.

## Security notes

* **Money is never a float.** Every amount is an integer number of poisha (`BigInt` in Prisma);
  the split puts the remainder on the last installment and the DB validates the sum.
* **A payment is only marked paid after server-side gateway verification**: the callback never
  trusts query parameters, it looks our own `paymentID` up, executes/queries the gateway and checks
  status, transaction id, exact amount and merchant invoice number before an atomic settlement
  (`UPDATE … WHERE status IN ('INITIATED','PENDING')` acts as a claim, so a duplicated callback
  cannot double-credit an installment).
* **Idempotency** comes from three places: the settlement claim, the unique index on
  `payments(gateway, trx_id)` (a replayed gateway id is rejected, not credited), and the
  reconciliation job that can safely run alongside a callback.
* **Least privilege:** VIEWER sees masked mobiles and no NID; ACCOUNTANT cannot touch nominees,
  admins or settings; only SUPER_ADMIN can read audit logs, NID scans and change settings.
* Secrets live in `server/.env` only (never in the client), and log output masks mobile numbers and
  never prints tokens, passwords or gateway secrets.

## Assumptions

1. **Single tenant, single currency (BDT).** No multi-currency or multi-branch support.
2. **Investors do not log in (v1).** Their only write action is starting a bKash payment with a
   valid link token; there is no investor-facing account, statement download or KYC upload.
3. **One investor mobile = one investor.** The mobile number is unique (it is the payer reference).
4. **Nominees are informational.** Shares must total 100 % and there can be at most three; payouts
   to nominees are handled outside the system.
5. **A reminder regenerates the payment link.** Tokens are stored hashed, so an old link cannot be
   recovered; each reminder SMS carries a fresh link and invalidates the previous one. Documented in
   `docs/payment-flow.md`.
6. **Refunds are recorded, not automated.** A gateway refund marks the payment `REFUNDED` only while
   it is still unsettled; refunds of settled money are handled by finance outside the system and
   reflected by waiving the installment with a reason.
7. **bKash is the only live gateway.** The adapter interface exists for Nagad/cards, but only bKash
   and the mock are implemented.
8. **Cron runs inside the API process** (one instance). Multi-instance deployments must either run a
   single designated worker or switch the scheduler to pg-boss.
9. **Asia/Dhaka is the business timezone** for due dates, reminders, cron and report buckets,
   regardless of the server timezone.
10. **Audit is append-only and permanent.** `DELETE`/`UPDATE` are blocked by a trigger; retention is
    a deliberate operations decision (see the migration comment about `TRUNCATE`).
11. **SMS is best-effort.** Delivery failures are logged per attempt and surfaced in the SMS log; the
    system never blocks a business action on an SMS provider.
12. **NID is optional.** Many investors do not have a scanned NID to hand; the field is optional but
    encrypted and access-controlled when present.
13. **The local PostgreSQL helper is for development only** (`scripts/local-postgres.sh`); production
    uses Supabase or a managed PostgreSQL.
14. **Rate limits are per IP and per account** with in-memory stores. Behind a load balancer, trust
    `X-Forwarded-For` (the app already honours `trust proxy`) or move the store to Redis.

## Feature checklist

| Feature | Status | Notes |
| --- | --- | --- |
| Auth: login, refresh rotation, logout, change password, lockout, rate limit | **Done** | argon2id, httpOnly cookies, reuse detection revokes the token family |
| 2FA (TOTP) setup with QR + verify, super-admin reset | **Done** | secret encrypted with AES-256-GCM |
| Admin management (create / role / enable / disable / unlock / reset password) | **Done** | SUPER_ADMIN only, audited |
| Investors CRUD + search / filter / sort / pagination / soft delete | **Done** | mobile + NID hash uniqueness enforced |
| Nominees (1–3, shares = 100 %) | **Done** | DB trigger + service validation, SUPER_ADMIN only |
| Photo & NID upload, NID privacy | **Done** | Cloudinary public/private + local fallback, signed URLs, audited views |
| Investments with auto-split and remainder on the last installment | **Done** | integer poisha, DB-validated sum |
| Schedule editing before payment, live sum UI | **Done** | server rejects edits once money has arrived |
| Waive / cancel / reopen with reason + audit | **Done** | |
| Payment links (hash-only storage, expiry, regeneration, SMS) | **Done** | single + bulk send, SMS delivery log |
| Public payment page (minimal data, rate limited, generic errors) | **Done** | first name, installment no, amount, due date only |
| bKash Tokenized Checkout (grant → create → execute → query) | **Done** | adapter + real sandbox flow; mock for dev/CI |
| Atomic settlement, idempotent callbacks, duplicate trx rejection | **Done** | one DB transaction per settlement |
| Reconciliation cron for stuck payments, optional webhook | **Done** | 15-minute job, webhook behind a flag |
| Success / failed / cancelled result pages | **Done** | `/pay/result?status=…` |
| PDF receipts | **Done** | `pdfkit`, receipt number, download audited |
| Manual payments (cash / bank / other, reference + note) | **Done** | ACCOUNTANT+, audited, generates a receipt |
| Dashboard KPIs + 12-month collection chart | **Done** | Asia/Dhaka buckets |
| Reports: due/overdue, collection register, investor statement | **Done** | filters + pagination |
| Excel (OOXML) and PDF exports | **Done** | `exceljs` workbooks with totals, exports audited |
| Reminder cron with dedupe, overdue status job | **Done** | per-installment `lastRemindedAt`, re-notify window |
| Audit log UI with filters + old/new values | **Done** | append-only, DB trigger blocks UPDATE/DELETE |
| Settings (link TTL, reminder lead time, branding) | **Done** | super admin, falls back to env |
| RBAC matrix documented + tested on every route | **Done** | `docs/permissions.md`, route-inventory test |
| Postman / OpenAPI | **Done** | `docs/openapi.yaml`, `docs/postman_collection.json` |
| Automated tests | **Done** | 136 tests across 18 files (Vitest + Supertest) |
| Deployment docs (Nginx, PM2, TLS, backup/restore) | **Done** | this README + `deploy/` |
| pg-boss scheduler | **Partial** | interface in place and swappable; node-cron used by default |
| Nagad / card gateways | **Not done** | adapter interface exists; only bKash implemented (out of scope for v1) |
| Automated refunds | **Partial** | refund states recorded; money movement is manual (assumption 6) |
| Investor self-service portal | **Not done** | out of scope for v1 (assumption 2) |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Invalid environment configuration` on boot | the message lists the offending variables; compare with `server/.env.example` |
| 403 on API calls from the browser | the origin is not in `CORS_ORIGINS` (include scheme + port) |
| SMS never arrives | `SMS_PROVIDER=console` prints to the API log and keeps an in-memory outbox; configure a real provider for delivery |
| Payment stays PENDING | check `pm2 logs` for gateway errors, then run the reconciliation job (`POST` a manual settle is not possible by design) |
| `migrate:deploy` cannot reach the database | use `DIRECT_URL` (port 5432) for migrations; the pooler does not support all DDL |
| Locked out | another super admin unlocks you, or `npm --workspace server run seed` recreates the first admin on an empty database |
