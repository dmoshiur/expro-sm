# Permissions matrix

Every endpoint below requires an authenticated admin session **and** passes
through `apiLimiter`. State-changing requests from a browser must be
same-origin (CSRF guard in `server/src/middleware/security.js`).

Roles (`admins.role`) — `ROLE_RANK` in `server/src/services/auth.service.js`:

| Role | Rank | Intent |
| --- | --- | --- |
| `SUPER_ADMIN` | 3 | Everything, including staff accounts, audit trail, nominee edits and NID documents. |
| `ACCOUNTANT` | 2 | Day-to-day bookkeeping: investors, investments, installments, manual payments, links, reports. |
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

Every NID reveal and NID-scan read is written to the audit log. A `VIEWER`
receives `mobile`/`email` masked, `address: '***'`, `nid_last4` masked and never
the ciphertext columns.

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

## Audit coverage

Written by the service layer with `old_value` / `new_value` (secrets redacted):

`LOGIN_SUCCESS`, `LOGIN_FAILED`, `LOGIN_LOCKED`, `LOGOUT`, `SESSION_REFRESHED`,
`SESSION_REVOKED`, `PASSWORD_CHANGED`, `PASSWORD_RESET`, `TOTP_SETUP_STARTED`,
`TOTP_ENABLED`, `TOTP_DISABLED`, `TOTP_VERIFY_FAILED`, `ADMIN_CREATED`,
`ADMIN_UPDATED`, `ADMIN_ROLE_CHANGED`, `ADMIN_DISABLED`, `ADMIN_ENABLED`,
`INVESTOR_CREATED`, `INVESTOR_UPDATED`, `INVESTOR_DEACTIVATED`,
`INVESTOR_RESTORED`, `INVESTOR_DELETED`, `INVESTOR_PHOTO_UPDATED`,
`INVESTOR_NID_UPDATED`, `INVESTOR_NID_VIEWED`, `NOMINEES_REPLACED`,
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
