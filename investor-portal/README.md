# Investor Installment Portal

An admin-only platform for collecting **investor installments** in Bangladesh. Staff create an
investor, split an investment into a schedule of installments, and send each installment a unique
secure payment link by SMS. The investor opens the link (no account, no login), pays with **bKash**,
and the server verifies the transaction with the gateway before marking the installment paid.
Everything is recorded in an append-only audit trail.

```
Admin UI (React SPA)  ──HTTPS──▶  Express API  ──Prisma──▶  Turso (libSQL / SQLite)
        │                              │
        │                              ├── bKash Tokenized Checkout (sandbox / live)
        │                              ├── SMS gateway (local BD provider or console)
        └── /pay/:token public page ───┴── Cloudinary (photos public, NID private)
```

## Highlights

| Area | What it does |
| --- | --- |
| Investors | CRUD, search / filter / sort / paginate, photo, optional NID scan (encrypted + private), 1–3 nominees with shares that must total 100 %, soft delete |
| Investments | Auto-split into N installments (integer **poisha**, remainder on the **last** installment), sum validated by the service on every write and re-checked by `npm run db:check`, editable before payment, waive / cancel / reopen with reason |
| Payment links | 32-byte random token, only the SHA-256 hash stored, configurable expiry, regeneration invalidates the old link, sent by SMS (single + bulk) with a delivery log |
| Payments | bKash Tokenized Checkout behind a gateway adapter, atomic settlement, idempotent callbacks, duplicate-transaction-id rejection, reconciliation cron, optional webhook, manual cash / bank entries |
| Receipts | PDF receipt per successful payment (`pdfkit`), receipt numbers `RC-YYYYMM-XXXXXX` |
| Dashboard | Invested / collected / outstanding / overdue, today's and month-to-date collection, 12-month trend chart, upcoming installments, recent payments |
| Reports | Due & overdue book, collection register, investor statement — screen + **Excel (OOXML, `exceljs`)** + **PDF** export, all exports audited |
| Reminders | Daily cron (Asia/Dhaka): due-in-N-days and overdue SMS, deduplicated via `lastRemindedAt`, re-notify window for overdue |
| Security | JWT in httpOnly + Secure + SameSite cookies with refresh rotation, argon2id, optional TOTP 2FA, account lockout, strict CORS, helmet, per-route rate limits, Zod on every route, AES-256-GCM for NID and 2FA secrets, masked PII in logs, request IDs |
| Audit | Service-layer audit log with old/new values; DB triggers block `UPDATE`/`DELETE` on `audit_logs`; only read endpoints exist |
| Integrity | `npm run db:check` verifies the invariants SQLite cannot express as deferred triggers (installment sums, nominee shares, money types, orphans) |
| RBAC | SUPER_ADMIN / ACCOUNTANT / VIEWER enforced by middleware — see `docs/permissions.md` |

## Monorepo layout

```
investor-portal/
├── server/                      # Express + TypeScript API
│   ├── src/
│   │   ├── config/              # env schema + Prisma client (libSQL/Turso driver adapter)
│   │   ├── controllers/         # HTTP layer (thin)
│   │   ├── routes/              # route tables + validation wiring
│   │   ├── middleware/          # auth, RBAC, CSRF, rate limits, upload, errors
│   │   ├── services/            # business logic (auth, investor, installment, payment, sms, receipt, report, audit, settings, dashboard, storage)
│   │   ├── jobs/                # node-cron scheduler (Asia/Dhaka) + swappable interface
│   │   ├── validators/          # Zod schemas
│   │   └── utils/               # money (poisha), dates (Dhaka), errors, encryption, permissions
│   ├── prisma/                  # schema, SQL migration (checks + triggers), seed
│   ├── scripts/                 # prisma launcher, libSQL migration applier, db reset,
│   │                            # integrity checker, Turso backup
│   ├── tests/                   # Vitest + Supertest (150 tests)
│   └── server.ts                # bootstrap
├── client/                      # React + Vite + TS SPA (Tailwind, TanStack Query, RHF + Zod)
│   ├── src/{pages,components,services,store,hooks,lib}
│   └── tests/                   # Vitest + Testing Library (jsdom) component tests
├── deploy/                      # Nginx, PM2, backup scripts
└── docs/                        # permissions, payment flow, OpenAPI, Postman
```

## Requirements

* Node.js **20.12+** (developed on 22; the server uses Node's built-in local `.env` loader) and npm 10+
* A database: a [Turso](https://turso.tech) database in production, or a local SQLite file for
  development and tests — no server, no Docker, no connection pooler
* Optional: Cloudinary account (file storage), bKash sandbox credentials, SMS gateway account

## Quick start (local, 5 minutes)

```bash
git clone <repo> && cd investor-portal
npm install                      # installs workspaces; prisma client generation is non-fatal here

cp server/.env.example server/.env         # TURSO_DATABASE_URL=file:./prisma/dev.db by default
cp client/.env.example client/.env
# optional: set SEED_SUPER_ADMIN_PASSWORD=Admin@12345 in server/.env to match the
# password used throughout the docs and the Postman collection

npm --workspace server run db:migrate      # applies prisma/migrations to the local libSQL file
npm --workspace server run seed            # creates the first SUPER_ADMIN + default settings

npm run dev                                # API on :4000, SPA on :5173 (Vite proxies /api)
```

The seed prints the initial super-admin credentials exactly once:

```
email:    admin@investorportal.local      (override with SEED_SUPER_ADMIN_EMAIL)
password: printed once                    (set SEED_SUPER_ADMIN_PASSWORD to choose it)
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
| `TURSO_DATABASE_URL` | the database the app talks to: `libsql://<db>-<org>.turso.io` (remote) or `file:./prisma/dev.db` (local). `DATABASE_URL` is accepted as an alias |
| `TURSO_AUTH_TOKEN` | database token for a remote Turso database (**secret**, `turso db tokens create`) — required whenever the URL is not a `file:` URL |
| `TURSO_SYNC_URL`, `TURSO_SYNC_INTERVAL`, `TURSO_ENCRYPTION_KEY` | optional **embedded replica**: read locally, write through to the primary |
| `TEST_DATABASE_URL` | throwaway database used by the Vitest suite (dropped + re-migrated on every run) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` | token signing and lifetimes (access 15 m, refresh 30 d by default) |
| `COOKIE_DOMAIN`, `COOKIE_SECURE` | cookie scoping (`secure` forced on in production) |
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM (NID numbers, TOTP secrets) — **rotating it invalidates stored NIDs/2FA secrets** |
| `CORS_ORIGINS` | comma-separated allowlist, exact origins in production. A **single-label wildcard** is supported for ephemeral hosts (e.g. `https://*.e2b.app` for sandbox previews) — it never matches the bare domain or crosses a dot, so it cannot be widened. Anything else is rejected with 403 |
| `RATE_LIMIT_DISABLED` | set to `1` in CI only |
| `BKASH_MODE`, `BKASH_BASE_URL`, `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_USERNAME`, `BKASH_PASSWORD`, `BKASH_CALLBACK_URL`, `BKASH_WEBHOOK_ENABLED`, `BKASH_WEBHOOK_SECRET` | bKash Tokenized Checkout. Mock payments are development/test-only; hosted deployments require credentials. `BKASH_BASE_URL` defaults to sandbox or live based on `BKASH_MODE` |
| `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_API_URL`, `SMS_SENDER_ID` | `console` (dev, prints + keeps an in-memory outbox), `bulksmsbd`, `alpha` |
| `STORAGE_DRIVER`, `LOCAL_STORAGE_DIR`, `CLOUDINARY_*` | `auto` uses Cloudinary when configured, otherwise local disk in development; hosted deployments require Cloudinary explicitly |
| `PAYMENT_LINK_TTL_DAYS`, `REMINDER_DAYS_BEFORE`, `REMINDER_ENABLED` | defaults; super admins can override the first two in **Settings** |
| `CRON_TIMEZONE`, `CRON_OVERDUE_MARK`, `CRON_REMINDERS`, `CRON_RECONCILE`, `CRON_TOKEN_CLEANUP` | cron expressions (all evaluated in Asia/Dhaka) |
| `RUN_JOBS` | `true` starts node-cron in a long-lived Node process. Always off on Vercel (serverless); set `false` on scaled-out API replicas and run one dedicated worker/scheduler |
| `COMPANY_NAME`, `SUPPORT_MOBILE`, `RECEIPT_PREFIX` | branding on the public page, SMS and receipts |
| `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD`, `SEED_SUPER_ADMIN_NAME`, `SEED_DEMO` | seed script inputs (password is generated when unset) |

`client/.env` only needs `VITE_API_BASE_URL` (leave empty in development to use the Vite proxy).

## Turso setup

1. Install the CLI and sign in, then create the database:

   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth login
   turso db create investor-portal
   turso db show investor-portal --url        # -> TURSO_DATABASE_URL
   turso db tokens create investor-portal     # -> TURSO_AUTH_TOKEN (store as a secret)
   ```

2. Point `server/.env` at it and apply the migrations:

   ```bash
   TURSO_DATABASE_URL="libsql://investor-portal-<org>.turso.io"
   TURSO_AUTH_TOKEN="..."

   npm --workspace server run db:migrate      # applies prisma/migrations over libSQL
   npm --workspace server run db:check        # verifies the integrity invariants
   ```

   `db:migrate` (scripts/apply-migrations.mjs) speaks libSQL directly, which is what makes remote
   Turso migrations work at all: the Prisma CLI's schema engine cannot dial `libsql://` URLs (the
   documented Turso flow is `prisma migrate diff` + `turso db shell`). Use `db:migrate` for both a
   local file and the remote database — the same SQL, the same `_prisma_migrations` bookkeeping the
   Prisma CLI uses.

3. Nothing else is required: the backend talks to Turso through Prisma only. There is no client-side
   database SDK anywhere in the codebase and the SPA never talks to the database directly. The
   database is reachable only with `TURSO_AUTH_TOKEN`, so — unlike a Supabase project with a public
   PostgREST endpoint — there is no second API surface to lock down (no RLS needed).

4. Optional: give a far-away deployment local reads with an **embedded replica**:

   ```bash
   TURSO_DATABASE_URL="file:./prisma/replica.db"
   TURSO_SYNC_URL="libsql://investor-portal-<org>.turso.io"
   TURSO_AUTH_TOKEN="..."
   TURSO_SYNC_INTERVAL=60
   ```

   Reads are served from the local file (sub-millisecond), writes are forwarded to the primary and
   the replica catches up on the interval. Keep the replica file on a persistent volume.

> **Constraint note.** The migration carries every check SQLite can express: installment amounts and
> paid amounts are positive integers (`paidAmount <= amount`), installment count 1–120,
> `payments(gateway, trxId)` is unique **when a transaction id exists** (partial index),
> `investors.nidHash` is unique, mobile numbers must be Bangladeshi, every enum column has a CHECK
> constraint, `audit_logs` blocks `UPDATE`/`DELETE` through triggers, and an investor can have at most
> 3 nominees with shares between 1 and 100.
>
> Two PostgreSQL guarantees could **not** be ported: `SUM(installments) = investment.totalAmount` and
> `SUM(nominee shares) = 100` were *deferred constraint triggers* (checked at COMMIT, which is what
> made multi-step edits inside one transaction possible) and SQLite has no deferred triggers. They are
> validated by the services on every write — the API returns `422` for an unbalanced schedule — and
> `npm run db:check` re-verifies the stored data (run it in CI, in cron or after a restore). See
> `scripts/lib/invariants.mjs`.

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

In development/test only, missing credentials select the **mock gateway**: `startPayment` returns a
redirect URL to the callback itself, and `mockGatewayControl` can script completed / failed /
cancelled / amount-mismatch outcomes. Hosted/production startup rejects missing bKash credentials.

## Database migrations

| Command | What it does |
| --- | --- |
| `npm --workspace server run db:migrate` | applies pending migrations to `TURSO_DATABASE_URL` (local file **or** remote Turso) |
| `npm --workspace server run migrate:status` | lists applied / pending migrations |
| `npm --workspace server run db:reset` | drops every table and re-applies all migrations (dev/test only, refuses remote URLs without `--force`) |
| `npm --workspace server run db:check` | verifies the integrity invariants (see the constraint note above) |
| `npm --workspace server run db:backup` | logical dump of schema + data to `server/backups/*.sql` |
| `npm --workspace server run prisma:generate` | regenerates the Prisma client into `server/src/generated/prisma` |
| `npm --workspace server run prisma:validate` | validates `prisma/schema.prisma` (offline: uses the bundled WASM engine) |

Authoring a new migration:

```bash
# on a machine where the Prisma CLI can download its schema engine:
npx prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma --shadow-database-url file:./prisma/shadow.db --script
# then paste the SQL into prisma/migrations/<timestamp>_<name>/migration.sql and run db:migrate
```

Applying an existing dump/backup is plain SQL as well:

```bash
turso db shell investor-portal < server/backups/turso-2026-10-05.sql
```

## Tests

```bash
npm test                       # server suite (resets investor_portal_test) then the client suite
npm --workspace server run test:watch
npm --workspace client run test:watch
npm run typecheck              # both workspaces (client typechecks src and tests)
npm run lint                   # both workspaces
npm run build                  # server tsc + client vite build
```

**Server** — Vitest + Supertest against a real libSQL/Turso database file and mocked bKash/SMS
(150 tests). `npm test` drops and re-migrates `TEST_DATABASE_URL` first, so the suite is
self-contained and needs no `.env` (see `tests/setup.ts`).
**Client** — Vitest + Testing Library in jsdom (`client/tests`): form validation state, label/ref
contracts of the shared primitives, etc.

Client-side forms follow one validation contract: a message appears only after the field was
blurred/touched or the form was submitted, and any "required" message disappears again as soon as
the field holds text (`client/src/lib/form.ts`). `<Input>`/`<Select>` are `forwardRef` components
because react-hook-form needs the DOM ref to read values — without it every field looks empty to the
resolver.

The server suite covers installment splitting and remainder, sum validation, token hashing / expiry /
regeneration, RBAC on **every** admin route (401 / 403 matrix incl. PII masking), duplicate
callbacks, duplicate transaction ids, cancelled and failed payments, amount mismatch, the
reconciliation job, the overdue-marker and token-cleanup jobs (Dhaka day boundary), manual payments
and receipts, reminders and dedupe, settings, audit writes, the nominee limit of three, and the
append-only audit trigger.

## Deployment (VPS: Nginx + PM2 + HTTPS)

```bash
# 1. server
sudo apt install -y nginx
curl -sSfL https://get.tur.so/install.sh | bash   # turso CLI (backups, ad-hoc SQL)
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

### Vercel (the repo ships a `vercel.json` with two services)

In Vercel, set the project Root Directory to the repository root (the directory containing
`vercel.json`) and the Framework Preset to **Services**. Do not point the project directly at
`investor-portal/server`, or Vercel will bypass the two-service routing configuration. The `client`
service builds the Vite
SPA; the `server` service explicitly uses `server/app.ts`, which exports an Express app as a
serverless function. `server/server.ts` remains the entrypoint for long-running Node/VPS deployments
and is not used by the Vercel service. This avoids opening a listening socket or starting a
process-local cron scheduler inside a serverless function.

Two details in that `vercel.json` are load-bearing; do not "simplify" them:

* The `server` service root is `investor-portal`, **not** `investor-portal/server`. `investor-portal`
  is the npm-workspace root, so it owns `package-lock.json` and the hoisted `node_modules`. Vercel
  bundles a service from its root downward and cannot include files above it: a service rooted at
  `investor-portal/server` ships a function with none of its dependencies and every `/api/*` request
  dies at import time with `Cannot find module '<first dependency>'` (surfaced as
  `500 FUNCTION_INVOCATION_FAILED`). Keep the root at the workspace root and point `entrypoint` at
  `server/app.ts`.
* The `client` service carries a service-scoped `/(.*) -> /index.html` rewrite. Without it the SPA's
  static file server answers deep links such as `/login` with `404 NOT_FOUND`, because no file named
  `login` exists. Top-level rewrites are evaluated first, so `/api/*` still reaches the server.

Prisma is the ORM/client, not the database host. Production requests use the configured hosted
libSQL database through `@prisma/adapter-libsql`; the local `file:./prisma/dev.db` URL is for
local development/tests only. Production never silently falls back to a local SQLite file,
ephemeral disk, a console SMS gateway or the mock bKash gateway: every missing setting is collected
at startup and reported with the subsystem it blocks.

How that report reaches you matters, so do not "simplify" it either:

* **Missing core settings** (`TURSO_*`, `JWT_*`, `ENCRYPTION_KEY`, `NID_HASH_PEPPER`, cookies,
  `CORS_ORIGINS`, `APP_BASE_URL`, `API_BASE_URL`) make every request answer
  `503 SERVICE_UNAVAILABLE` with the exact list in `error.details.problems`. The function still
  boots, so a half-configured deployment tells you what is missing instead of returning the opaque
  `500 FUNCTION_INVOCATION_FAILED` on every `/api/*` route (`config` would previously throw at
  import time, which kills the whole serverless function - including `/health` and the login).
* **Feature settings** (`STORAGE_DRIVER`/Cloudinary → uploads, `BKASH_*` → the checkout,
  `SMS_*` → payment-link/reminder SMS) are scoped: the rest of the portal keeps working, and only
  the unconfigured feature fails closed with its own 503. Missing bKash or SMS credentials must not
  prevent an administrator from logging in.
* `RUN_JOBS` is forced off on Vercel (in-process node-cron cannot run in a serverless function), so
  there is nothing to set there; don't re-add a guardrail that demands `RUN_JOBS=false`.
* A Vercel deployment derives its **own origin** (`VERCEL_PROJECT_PRODUCTION_URL` for production,
  `VERCEL_URL` for previews): `APP_BASE_URL`, `API_BASE_URL`, `BKASH_CALLBACK_URL` and the
  `CORS_ORIGINS` allowlist fall back to it whenever the configured value is empty or a loopback URL
  (`localhost`/`127.0.0.1`, i.e. the placeholders people copy out of `.env.example`). A deliberate
  non-local value is never rewritten - it stays a normal configuration problem. Every replacement is
  logged at startup (`[config] APP_BASE_URL=http://localhost:5173 is not usable on a hosted
  deployment - using https://...`) and listed by `env:check`, so a payment link or SMS that ends up
  on the wrong host can always be traced back to one line.

Uploads use Cloudinary in production; local uploads remain a development/test adapter.

Add these values to the Vercel project's **Production** environment (use isolated Turso/Cloudinary
credentials for Preview when enabling Preview deployments):

```env
NODE_ENV=production
TURSO_DATABASE_URL=libsql://<database>-<organization>.turso.io
TURSO_AUTH_TOKEN=<Turso database token>
STORAGE_DRIVER=cloudinary
CLOUDINARY_CLOUD_NAME=<cloud name>
CLOUDINARY_API_KEY=<api key>
CLOUDINARY_API_SECRET=<api secret>
BKASH_MODE=live
BKASH_BASE_URL=https://tokenized.pay.bka.sh/v1.2.0-beta
BKASH_APP_KEY=<merchant app key>
BKASH_APP_SECRET=<merchant app secret>
BKASH_USERNAME=<merchant username>
BKASH_PASSWORD=<merchant password>
JWT_ACCESS_SECRET=<at least 32 random characters>
JWT_REFRESH_SECRET=<a different 32+ character secret>
ENCRYPTION_KEY=<32-byte base64 or hex key>
NID_HASH_PEPPER=<a different 32+ character secret>
CORS_ORIGINS=https://portal.example.com
APP_BASE_URL=https://portal.example.com
API_BASE_URL=https://portal.example.com
BKASH_CALLBACK_URL=https://portal.example.com/api/public/payments/bkash/callback
SMS_PROVIDER=bulksmsbd
SMS_API_URL=https://<your-sms-provider>/api/send
SMS_API_KEY=<SMS provider key>
SMS_SENDER_ID=<approved sender ID>
# RUN_JOBS is not needed here: jobs are always off on Vercel
```

Vercel injects environment variables at runtime; it does not need a `.env` file or the `dotenv`
package. Apply database migrations from CI or a trusted local machine with the same Turso URL/token
before sending traffic (`npm --workspace server run db:migrate`). The Vercel build only generates the
Prisma client and compiles the server; it never applies schema changes to production automatically.

Check the environment before deploying it, with the exact rules the server enforces at boot:

```bash
vercel env pull .env.production      # or copy the values from the dashboard
npm --workspace server run env:check -- --env-file .env.production
#   -> lists every missing/invalid setting with its scope and exits non-zero when something is missing
# `--self-hosted` checks a VPS/container deployment instead of Vercel production; `--json` is for CI.
```

A 503 from a deployed API carries the same list in `error.details.problems` (`curl -s https://<app>/api/health`
shows it too), so the dashboard logs are not the only way to find out what is missing.

Do not run the Node cron scheduler in a Vercel function: jobs are automatically disabled there
(`config.runJobs` is false on Vercel) and no `RUN_JOBS` value is needed. Run exactly one long-lived
worker/server with `RUN_JOBS=true` on a persistent Node/container host, or move the scheduled jobs to
a managed queue/scheduler; set `RUN_JOBS=false` on any additional API instances you scale out.

Checklist before going live:

* `NODE_ENV=production`, `COOKIE_SECURE=true`, real `JWT_*`/`ENCRYPTION_KEY` secrets (32-byte random)
* `CORS_ORIGINS=https://portal.example.com`
* `APP_BASE_URL=https://portal.example.com` (SMS links + gateway redirects)
* Cloudinary credentials set; bKash switched from `sandbox` to `live`
* Cron jobs run **inside** the API process (node-cron, Asia/Dhaka). Keep exactly **one** PM2 instance
  in `fork` mode with `RUN_JOBS=true`; if you must scale out, set `RUN_JOBS=false` on the extra
  instances so each job still runs exactly once (or move the scheduler to a queue, see below)
* Daily Turso backup scheduled (see below) and a restore rehearsed at least once

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

Turso keeps managed snapshots, but keep an independent logical copy off the database host:

```bash
# server-side dump (Turso CLI)
turso db dump investor-portal --output /var/backups/investor-portal-$(date +%F).sql

# or the dependency-free fallback used by deploy/backup.sh (works for a local
# file and for a remote database, and for an embedded replica):
npm --workspace server run db:backup -- --out /var/backups/investor-portal-$(date +%F).sql

# restore (staging rehearsal)
turso db shell investor-portal < /var/backups/investor-portal-2026-10-04.sql
```

`deploy/backup.sh` wraps that with retention (14 daily / 8 weekly files) and checksums. For a
point-in-time restore of a remote database prefer `turso db dump`; for an embedded replica the file
itself is a valid snapshot (`VACUUM INTO` is the fastest way to copy it while the app runs).

## Security notes

* **Money is never a float.** Every amount is an integer number of poisha (`BigInt` in Prisma, and
  the libSQL driver runs with `intMode: 'bigint'` so nothing is ever coerced through a JS number);
  the split puts the remainder on the last installment, the service validates the sum on every write
  and `npm run db:check` verifies the stored data.
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
* **CORS and CSRF share one allowlist matcher** (`src/utils/origin.ts`): exact origins plus optional
  single-label wildcards for ephemeral dev/preview hosts. Requests without an `Origin` header
  (curl, cron, gateway webhooks) pass because they carry no browser session.
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
10. **Audit is append-only and permanent.** `DELETE`/`UPDATE` are blocked by triggers (the test
    suite drops them only to wipe fixtures, then puts them straight back). Retention is a deliberate
    operations decision — SQLite has no `TRUNCATE`, so pruning means deleting through a maintenance
    role with the triggers temporarily dropped.
11. **SMS is best-effort.** Delivery failures are logged per attempt and surfaced in the SMS log; the
    system never blocks a business action on an SMS provider.
12. **NID is optional.** Many investors do not have a scanned NID to hand; the field is optional but
    encrypted and access-controlled when present.
13. **SQLite is the whole database engine now.** That buys zero-ops, serverless-friendly storage and
    single-digit-millisecond reads; in exchange, a few PostgreSQL-only features are gone (deferred
    constraint triggers, native enums, RLS, `ILIKE`, `date_trunc`). What replaced them is documented in
    the constraint note above and in `prisma/migrations/20260101000000_init/migration.sql`.
14. **Case-insensitive search** relies on SQLite's `LIKE` (case-insensitive for ASCII); non-ASCII
    text is compared case-sensitively.
15. **Rate limits are per IP and per account** with in-memory stores. Behind a load balancer, trust
    `X-Forwarded-For` (the app already honours `trust proxy`) or move the store to Redis.

## Feature checklist

| Feature | Status | Notes |
| --- | --- | --- |
| Auth: login, refresh rotation, logout, change password, lockout, rate limit | **Done** | argon2id, httpOnly cookies, reuse detection revokes the token family |
| 2FA (TOTP) setup with QR + verify, super-admin reset | **Done** | secret encrypted with AES-256-GCM |
| Admin management (create / role / enable / disable / unlock / reset password) | **Done** | SUPER_ADMIN only, audited |
| Investors CRUD + search / filter / sort / pagination / soft delete | **Done** | mobile + NID hash uniqueness enforced |
| Nominees (1–3, shares = 100 %) | **Done** | DB trigger for the count, service validation for the shares, SUPER_ADMIN only |
| Photo & NID upload, NID privacy | **Done** | Cloudinary public/private + local fallback, signed URLs, audited views |
| Investments with auto-split and remainder on the last installment | **Done** | integer poisha, service-validated sum + `db:check` |
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
| Integrity checker (`db:check`) + logical Turso backup (`db:backup`) | **Done** | `scripts/lib/invariants.mjs`, `scripts/turso-backup.mjs` |
| Audit log UI with filters + old/new values | **Done** | append-only, DB trigger blocks UPDATE/DELETE |
| Settings (link TTL, reminder lead time, branding) | **Done** | super admin, falls back to env |
| RBAC matrix documented + tested on every route | **Done** | `docs/permissions.md`, route-inventory test |
| Postman / OpenAPI | **Done** | `docs/openapi.yaml`, `docs/postman_collection.json` |
| Automated tests | **Done** | 150 server tests (21 files) + 13 client component tests (3 files) |
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
| `db:migrate` cannot reach the database | check `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`; for a remote database the token must have write access (`turso db tokens create <db>`) |
| Locked out | another super admin unlocks you, or `npm --workspace server run seed` recreates the first admin on an empty database |
