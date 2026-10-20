# Permissions matrix

Every endpoint below requires an authenticated admin session **and** passes
through `apiLimiter`. State-changing requests from a browser must be
same-origin (CSRF guard in `server/src/middleware/security.js`).

Roles (`admins.role`) — `ROLE_RANK` in `server/src/services/auth.service.js`:

| Role | Rank | Intent |
| --- | --- | --- |
| `SUPER_ADMIN` | 3 | Everything, including staff accounts, audit trail, nominee edits, NID documents, document review, membership approval and account freeze. |
| `ACCOUNTANT` | 2 | Day-to-day bookkeeping: investors, investments, installments, manual payments, links, wallet ledger + request decisions, support replies, reports. |
| `VIEWER` | 1 | Read-only dashboards/lists. All personal data is masked. |

## Enforcement points

* `requireAuth` — any valid session (all `/api/*` except `/api/health`, `/api/auth/login`, `/api/auth/logout`, `/api/public/*`).
* `requireRole('SUPER_ADMIN','ACCOUNTANT')` — writes.
* `requireSuperAdmin` — staff, audit, jobs, NID documents, test SMS.
* Service layer also masks PII for `VIEWER` (`presentInvestor`, `presentNominees`),
  so masking does not depend on the controller.

## Endpoint matrix

### Public (no session — token + rate limits only)

| Method & path | Notes |
| --- | --- |
| `GET /api/public/pay/:token` | Minimal projection: first name, installment no., amount, due date, masked mobile, status. Generic 404 / 410 on invalid or expired links. |
| `POST /api/public/pay/:token/start` | Creates (or reuses, inside a 60s window) a gateway payment. `payStartLimiter` (default 10/min/IP). |
| `POST /api/public/pay/:token/verify` | Re-queries the gateway; the browser is never trusted. |
| `GET /pay/callback` | Gateway redirect target. Ignores every status query param. |
| `GET /pay/result` | Plain HTML fallback when the SPA is unavailable. |

### Authentication

| Endpoint | SUPER_ADMIN | ACCOUNTANT | VIEWER |
| --- | --- | --- | --- |
| `POST /api/auth/login` (rate-limited, lockout) | ✅ | ✅ | ✅ |
| `POST /api/auth/logout`, `POST /api/auth/refresh` | ✅ | ✅ | ✅ |
| `GET /api/auth/me` | ✅ | ✅ | ✅ |
| `POST /api/auth/2fa/*`, `POST /api/auth/totp/*` (own account) | ✅ | ✅ | ✅ |
| `POST /api/auth/change-password` (own account) | ✅ | ✅ | ✅ |
| `GET /api/auth/sessions`, `POST /api/auth/sessions/revoke-others` | ✅ | ✅ | ✅ |

### Staff accounts (`/api/admins`)

| Endpoint | SUPER_ADMIN | ACCOUNTANT | VIEWER |
| --- | --- | --- | --- |
| `GET /api/admins` | ✅ | ❌ 403 | ❌ 403 |
| `POST /api/admins` | ✅ | ❌ | ❌ |
| `PATCH /api/admins/:id` (role, active, name) | ✅ | ❌ | ❌ |
| `POST /api/admins/:id/reset-password` | ✅ | ❌ | ❌ |
| `POST /api/admins/:id/reset-totp` | ✅ | ❌ | ❌ |
| `POST /api/admins/:id/revoke-sessions` | ✅ | ❌ | ❌ |

Guards: at least one active `SUPER_ADMIN` must remain, an admin cannot disable
itself, a role change revokes that admin's sessions, and an active→disabled
transition revokes every session immediately.

### Investors

| Endpoint | SUPER_ADMIN | ACCOUNTANT | VIEWER |
| --- | --- | --- | --- |
| `GET /api/investors`, `GET /api/investors/:id` | ✅ | ✅ | ✅ (masked) |
| `GET /api/investors/:id/photo` | ✅ | ✅ | ✅ |
| `GET /api/investors/export.csv` | ✅ | ✅ | ✅ (masked) |
| `POST /api/investors`, `PATCH /api/investors/:id` | ✅ | ✅ | ❌ |
| `POST /api/investors/:id/status` (ACTIVE/INACTIVE/CLOSED) | ✅ | ✅ | ❌ |
| `DELETE /api/investors/:id` (soft delete), `POST /api/investors/:id/restore` | ✅ | ✅ | ❌ |
| `POST /api/investors/:id/photo` | ✅ | ✅ | ❌ |
| `POST /api/investors/:id/nominees`, `PATCH/DELETE …/nominees/:nomineeId` | ✅ | ❌ 403 | ❌ 403 |
| `POST /api/investors/:id/nid` (set/replace NID) | ✅ | ❌ | ❌ |
| `GET /api/investors/:id/nid` (reveal), `GET …/nominees/:id/nid` | ✅ | ❌ | ❌ |
| `GET /api/investors/:id/nid-scan`, `POST /api/investors/:id/nid-scan` | ✅ | ❌ | ❌ |
| `GET /api/investors/:id/portal-access` | ✅ | ✅ | ✅ (mobile masked) |
| `POST /api/investors/:id/portal-access/password` (set/reset, optional SMS) | ✅ | ✅ | ❌ |
| `POST /api/investors/:id/portal-access/enabled`, `…/revoke-sessions` | ✅ | ✅ | ❌ |
| `GET /api/investors/:id/wallet` (summary + ledger) | ✅ | ✅ | ✅ |
| `POST /api/investors/:id/wallet/transactions` (manual ledger entry) | ✅ | ✅ | ❌ |
| `POST /api/investors/:id/wallet/transactions/:txId/decide` (APPROVE/REJECT) | ✅ | ✅ | ❌ |
| `GET /api/investors/:id/documents` (slot states) | ✅ | ✅ | ✅ (no bytes) |
| `POST /api/investors/:id/documents/:kind` (raw image / PDF body) | ✅ | PHOTO / NOMINEE_PHOTO only | ❌ |
| `GET /api/investors/:id/documents/:kind/file` | ✅ | PHOTO / NOMINEE_PHOTO only | ❌ |
| `POST /api/investors/:id/documents/:kind/review`, `…/nominees/:nomineeId/photo/review` | ✅ | ❌ 403 | ❌ |
| `POST /api/investors/:id/membership` (APPROVED/REJECTED) | ✅ | ❌ | ❌ |
| `POST /api/investors/:id/freeze` (frozen + reason) | ✅ | ❌ | ❌ |

The document slots are `PHOTO`, `NID_FRONT`, `NID_BACK`, `SIGNATURE` and
`NOMINEE_PHOTO`. Every upload is audited and resets the slot to `PENDING`;
only a Super Admin can `VERIFIED` / `REJECTED` it (rejection requires a note).
Freezing requires a reason, blocks withdrawals / pay links and revokes the
investor's live portal sessions.

Every NID reveal and NID-scan read is written to the audit log. A `VIEWER`
receives `mobile`/`email`/`alternate_mobile` masked, addresses `'***'`,
`nid_last4` masked and never the ciphertext columns. `password_hash` (the
investor's portal credential) is stripped in the service layer for every role.

### Investor portal (`/api/portal`, investor session cookie)

A second, fully separate login system for investors: own cookie
(`INVESTOR_COOKIE_NAME`), own table (`investor_sessions`), own lockout.
Admin cookies mean nothing here and vice versa. Login id is the mobile
number or the member code (`INV-000123`). There is no public sign-up and no
self-service reset: staff issue a **temporary** password (investor page →
Portal access, or at investor creation), optionally by SMS; the investor
must replace it at first sign-in (`403 PASSWORD_CHANGE_REQUIRED` everywhere
else until then). Only `ACTIVE`, non-deleted, portal-enabled investors can
sign in; disabling access, deactivating the investor or resetting the
password revokes live sessions immediately.

| Endpoint | Notes |
| --- | --- |
| `POST /api/portal/auth/login` (rate-limited, lockout) | Generic 401 for unknown id / wrong password; 423 when locked. |
| `POST /api/portal/auth/logout`, `GET /api/portal/auth/me` | Own session only. |
| `POST /api/portal/auth/change-password` | ≥8 chars, letter + digit, never the mobile / member code / own name. Revokes other sessions. |
| `POST /api/portal/auth/sessions/revoke-others` | Keeps the current session. |
| `GET /api/portal/dashboard` | Own totals: invested / paid / remaining / due now / overdue, next due, profile completeness. |
| `GET /api/portal/profile`, `PATCH /api/portal/profile` | Contact fields only: email, alternate mobile, gender, religion, education, present / permanent address. **Identity fields are locked** and answered with `403 FIELD_LOCKED` (`details.fields`), audited as `PORTAL_LOCKED_FIELD_BLOCKED`: name, name_bangla, mobile, date_of_birth, father_name, mother_name, nid, status, membership_status, member_code. Admin `notes` are never returned. |
| `GET /api/portal/investments`, `…/installments`, `…/payments` | Scoped by session investor id - there is no `:id` in portal URLs. |
| `POST /api/portal/installments/:id/pay-link` | Own open installment only (others → 404); reuses the public bKash pay flow. |
| `GET /api/portal/photo`, `GET /api/portal/nid-scan` | Own photo / encrypted NID scan (owner read, audited). **No upload route exists for investors.** |
| `GET /api/portal/wallet` | Own summary + ledger only. |
| `POST /api/portal/wallet/requests` | Deposit / withdrawal **requests** (PENDING); never writes a completed balance. |
| `GET /api/portal/documents` | Own slot states (photo, NID front/back, signature, nominee photos). Read-only. |
| `POST /api/portal/documents/:kind` | **Removed.** Investors cannot upload documents; staff upload from the admin profile (`ACCOUNTANT` for photo and nominee photos only; `SUPER_ADMIN` for NID and signature). |
| `GET /api/portal/documents/:kind/file`, `GET /api/portal/nominees/:id/photo` | Own bytes only; NID / signature reads audited. |
| `POST /api/portal/nominees/:nomineeId/photo` | **Removed.** Nominee photos are maintained by staff. |
| `GET/POST /api/portal/support/tickets`, `…/:id/messages`, `…/:id/close` | Own tickets only; investors cannot address another investor's ticket. |
| `GET /api/portal/statement.html`, `GET /api/portal/certificate` | Own print-ready statement / membership certificate. |
| `GET /api/portal/payments/:id/receipt` | Own successful payments only (others → 404). |
| `GET /api/portal/statement.csv` | Own statement; audited as a report export. |
| `GET /api/portal/donations` | Fund list, presets, own totals and the 20 most recent donations. |
| `POST /api/portal/donations` | Starts a donation: `{ fundCode, amount }` (৳10 to ৳5,00,000). Creates the row, then the gateway payment. Rate-limited like pay-link. Frozen accounts are refused (the session is revoked). |
| `GET /api/portal/donations/:id` | Own donation only (others → 404). Never includes raw gateway payloads. |
| `POST /api/portal/donations/:id/verify` | Re-queries the gateway for an open donation. The browser's claim is never trusted. A settled donation is never reverted. |
| `GET /api/portal/donations/:id/receipt` | Own successful donation only (others → 404; not successful → 400). Audited as `DONATION_RECEIPT_VIEWED`. |
| `GET /pay/callback?kind=donation` (public redirect) | Shared gateway callback. Looks up the payment id, re-checks with the gateway, then settles. Browser query values are ignored. |

### Donations (staff, read-only)

| Endpoint | SUPER_ADMIN | ACCOUNTANT | VIEWER |
| --- | --- | --- | --- |
| `GET /api/donations` (filters: status, fund, search, paging) | ✅ | ✅ | ✅ |

The staff list shows the investor's name and member code and **never a mobile
number**. Staff cannot create, edit, cancel or refund donations from the admin app.

### Investments & installments

| Endpoint | SUPER_ADMIN | ACCOUNTANT | VIEWER |
| --- | --- | --- | --- |
| `GET /api/investments*`, `GET /api/installments*` | ✅ | ✅ | ✅ |
| `GET /api/reports/*` (due, overdue, collections, statements, CSV/HTML) | ✅ | ✅ | ✅ |
| `POST /api/investments`, `PATCH …/total`, `POST …/status` | ✅ | ✅ | ❌ |
| `PATCH /api/installments/:id` (amount, due date) | ✅ | ✅ | ❌ |
| `POST /api/installments/:id/state` (WAIVE/CANCEL/REINSTATE, reason required) | ✅ | ✅ | ❌ |
| `POST /api/installments/:id/pay-link` (issue/regenerate) | ✅ | ✅ | ❌ |
| `POST /api/installments/:id/send-link`, `POST /api/installments/bulk/send-links` (≤50, 3/min) | ✅ | ✅ | ❌ |

### Payments

| Endpoint | SUPER_ADMIN | ACCOUNTANT | VIEWER |
| --- | --- | --- | --- |
| `GET /api/payments`, `GET /api/payments/:id`, `GET /api/payments/provider` | ✅ | ✅ | ✅ |
| `GET /api/payments/:id/receipt`, `…/receipt.json`, `GET /api/payments/export.csv` | ✅ | ✅ | ✅ |
| `POST /api/payments/manual` (reference + note required) | ✅ | ✅ | ❌ |
| `POST /api/payments/:id/refresh` | ✅ | ✅ | ❌ |
| `POST /api/payments/:id/cancel` | ✅ | ✅ | ❌ |
| `POST /api/payments/webhook` | disabled unless `PAYMENTS_WEBHOOK_ENABLED=true` + secret header | | |

Cancelling: an open/failed attempt is simply closed. A **manual** SUCCESS
payment is voided and the installment's `amount_paid` is reversed (audited with
the reversal). A settled **bKash** payment cannot be voided here — refund it in
bKash and record the adjustment manually.

### Audit, jobs, SMS

| Endpoint | SUPER_ADMIN | ACCOUNTANT | VIEWER |
| --- | --- | --- | --- |
| `GET /api/audit`, `GET /api/audit/filters` | ✅ | ❌ 403 | ❌ 403 |
| `GET /api/jobs`, `POST /api/jobs/:name/run` | ✅ | ❌ | ❌ |
| `GET /api/sms`, `GET /api/sms/provider` | ✅ | ✅ | ✅ |
| `POST /api/sms/test` (rate-limited 5/min) | ✅ | ❌ 403 | ❌ 403 |

### Health

`GET /api/health` is unauthenticated: process status, DB round-trip, migration
count, scheduler state. No secrets, no PII.

### Support inbox (`/api/support`)

| Endpoint | SUPER_ADMIN | ACCOUNTANT | VIEWER |
| --- | --- | --- | --- |
| `GET /api/support/summary` | ✅ | ✅ | ✅ |
| `GET /api/support/tickets`, `GET /api/support/tickets/:id` | ✅ | ✅ | ✅ |
| `POST /api/support/tickets/:id/messages`, `POST …/:id/status` | ✅ | ✅ | ❌ |

Investors open and read only their own tickets through `/api/portal/support/*`.
Statuses move OPEN → IN_PROGRESS → RESOLVED → CLOSED; an investor reply on a
RESOLVED ticket reopens it, and a staff reply on an OPEN ticket moves it to
IN_PROGRESS. Every change is audited.

## Audit coverage

Written by the service layer with `old_value` / `new_value` (secrets redacted):

`LOGIN_SUCCESS`, `LOGIN_FAILED`, `LOGIN_LOCKED`, `LOGOUT`, `SESSION_REFRESHED`,
`SESSION_REVOKED`, `PASSWORD_CHANGED`, `PASSWORD_RESET`, `TOTP_SETUP_STARTED`,
`TOTP_ENABLED`, `TOTP_DISABLED`, `TOTP_VERIFY_FAILED`, `ADMIN_CREATED`,
`ADMIN_UPDATED`, `ADMIN_ROLE_CHANGED`, `ADMIN_DISABLED`, `ADMIN_ENABLED`,
`INVESTOR_CREATED`, `INVESTOR_UPDATED`, `INVESTOR_DEACTIVATED`,
`INVESTOR_RESTORED`, `INVESTOR_DELETED`, `INVESTOR_PHOTO_UPDATED`,
`INVESTOR_NID_UPDATED`, `INVESTOR_NID_VIEWED`, `INVESTOR_LOGIN_SUCCESS`,
`INVESTOR_LOGIN_FAILED`, `INVESTOR_LOGIN_LOCKED`, `INVESTOR_LOGOUT`,
`INVESTOR_PASSWORD_CHANGED`, `INVESTOR_PASSWORD_SET`,
`INVESTOR_PORTAL_ENABLED`, `INVESTOR_PORTAL_DISABLED`,
`INVESTOR_SESSIONS_REVOKED`, `INVESTOR_PROFILE_UPDATED`, `NOMINEES_REPLACED`,
`NOMINEE_UPDATED`, `INVESTMENT_CREATED`, `INVESTMENT_UPDATED`,
`INVESTMENT_TOTAL_CHANGED`, `INVESTMENT_STATUS_CHANGED`, `INSTALLMENT_UPDATED`,
`INSTALLMENT_WAIVED`, `INSTALLMENT_CANCELLED`, `INSTALLMENT_REINSTATED`,
`INSTALLMENT_OVERDUE_MARKED`, `PAY_LINK_GENERATED`, `PAY_LINK_REGENERATED`,
`PAY_LINK_ACCESSED`, `PAY_LINK_INVALID`, `PAYMENT_INITIATED`,
`PAYMENT_VERIFIED`, `PAYMENT_FAILED`, `PAYMENT_CANCELLED`,
`PAYMENT_MANUAL_RECORDED`, `RECEIPT_VIEWED`, `SMS_SENT`, `SMS_FAILED`,
`REMINDER_SENT`, `JOB_RUN`, `REPORT_EXPORTED`, `UNAUTHORIZED_ATTEMPT`.

`audit_logs` is append-only at the database level (UPDATE/DELETE/TRUNCATE raise
an exception), so no application role can rewrite history.
