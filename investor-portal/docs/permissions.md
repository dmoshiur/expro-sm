# Permissions

Three roles. The matrix is implemented in `server/src/utils/permissions.ts` and enforced by the
`requirePermission()` middleware on every route; `server/tests/rbac.routes.test.ts` walks the whole
route inventory to prove it.

| Capability | SUPER_ADMIN | ACCOUNTANT | VIEWER |
| --- | :--: | :--: | :--: |
| Dashboard & reports (read) | ✅ | ✅ | ✅ |
| Export Excel/PDF | ✅ | ✅ | ❌ |
| Investors — read | ✅ | ✅ | ✅ (masked) |
| Investors — create / update | ✅ | ✅ | ❌ |
| Investors — deactivate / reactivate | ✅ | ❌ | ❌ |
| Nominees — read | ✅ | ✅ (masked) | ✅ (masked) |
| Nominees — create / update / delete | ✅ | ❌ | ❌ |
| NID value + NID scan (view/download) | ✅ | ❌ | ❌ |
| Full mobile number | ✅ | ❌ (masked) | ❌ (masked) |
| Investments — read | ✅ | ✅ | ✅ |
| Investments — create / edit / cancel | ✅ | ✅ | ❌ |
| Installments — edit schedule | ✅ | ✅ | ❌ |
| Installments — waive / cancel / reopen | ✅ | ✅ | ❌ |
| Payment links — generate / send / regenerate | ✅ | ✅ | ❌ |
| Manual payments (cash / bank / other) | ✅ | ✅ | ❌ |
| Payments — read, receipts | ✅ | ✅ | ✅ |
| Admissions — SMS log | ✅ | ✅ | ✅ (masked destination) |
| Audit log | ✅ | ❌ | ❌ |
| Admin management | ✅ | ❌ | ❌ |
| Settings | ✅ | ❌ | ❌ |

Legend: ✅ allowed · ❌ denied (403).

## Permission keys

| Key | Meaning |
| --- | --- |
| `admin:manage` | create/update admins, reset password or 2FA, unlock |
| `audit:read` | read the audit log |
| `settings:write` | read/update runtime settings |
| `investor:read` / `investor:write` | investor list and profile changes |
| `investor:nominee:write` | create/update/delete nominees |
| `investor:sensitive:read` | NID value, NID scan URL, unmasked mobile |
| `investment:read` / `investment:write` | investments and their schedule |
| `installment:write` | edit installments before payment |
| `installment:waive` | waive / cancel / reopen |
| `payment:read` / `payment:manual` | payment list, detail, receipts / manual entries |
| `paymentlink:send` / `paymentlink:regenerate` | SMS a link / mint a new one |
| `report:read` / `report:export` | reports / Excel + PDF exports |

## Route → permission map

| Method & path | Permission |
| --- | --- |
| `POST /api/auth/login` | public (rate limited: 10 / 15 min / IP + account lockout) |
| `POST /api/auth/refresh` | refresh cookie |
| `POST /api/auth/logout` | optional auth |
| `GET /api/auth/me` | authenticated |
| `POST /api/auth/change-password` | authenticated (revokes all sessions) |
| `POST /api/auth/2fa/setup`, `/2fa/verify`, `/2fa/disable` | authenticated |
| `GET /api/admins`, `POST /api/admins`, `PATCH /api/admins/:id`, `POST /api/admins/:id/reset-password`, `/reset-2fa`, `/unlock` | `admin:manage` |
| `GET /api/investors`, `GET /api/investors/:id` | `investor:read` |
| `POST /api/investors`, `PATCH /api/investors/:id` | `investor:write` |
| `POST /api/investors/:id/deactivate`, `/reactivate` | `investor:write` + SUPER_ADMIN |
| `PUT /api/investors/:id/nominees` | `investor:nominee:write` (SUPER_ADMIN only) |
| `POST /api/investors/:id/photo`, `/nid-scan` | `investor:write` (NID scan: SUPER_ADMIN) |
| `GET /api/investors/:id/nid-scan-url` | `investor:sensitive:read` (SUPER_ADMIN only) |
| `GET /api/investments`, `GET /api/investments/:id`, `GET /api/installments` | `investment:read` |
| `POST /api/investments`, `PATCH /api/investments/:id` | `investment:write` |
| `POST /api/investments/:id/cancel`, `PUT /api/investments/:id/installments` | `installment:write` |
| `POST /api/installments/:id/waive`, `/cancel`, `/reopen` | `installment:waive` |
| `POST /api/payments/installments/:id/link/regenerate` | `paymentlink:regenerate` |
| `POST /api/payments/installments/:id/link/send`, `POST /api/payments/investments/:id/links/send` | `paymentlink:send` |
| `GET /api/payments`, `GET /api/payments/:id`, `GET /api/payments/:id/receipt.pdf` | `payment:read` |
| `POST /api/payments/installments/:id/manual` | `payment:manual` |
| `GET /api/payments/sms-logs` | `payment:read` |
| `GET /api/dashboard` | `report:read` |
| `GET /api/reports/due`, `/collections`, `/investors/:id/statement` | `report:read` |
| `GET /api/reports/*.xlsx`, `/investors/:id/statement.pdf` | `report:export` |
| `GET /api/audit-logs`, `/actions` | `audit:read` (SUPER_ADMIN only) |
| `GET /api/settings`, `PUT /api/settings` | `settings:write` (SUPER_ADMIN only) |
| `GET /api/public/*`, `POST /api/public/payments/:token/start` | public (rate limited, no session) |
| `GET /api/files/local/*` | authenticated (local storage driver only) |

## Field-level rules for VIEWER and ACCOUNTANT

* Mobile numbers are returned masked (`01712****78`) and the audit log records the *masked* value.
* NID values are never decrypted for these roles; the API returns `null` (or a masked NID when one is
  stored) and `hasNid` / `hasNidScan` booleans so the UI can still show the right state.
* Exports are blocked entirely for VIEWER because a spreadsheet cannot be masked after download.

## Escalation & auditing

* Every write action records actor, IP, user agent, old value and new value in `audit_logs`, which
  the database blocks from being updated or deleted.
* Rising a role is itself audited (`admin.role_changed`), as are 2FA resets, password resets,
  lockouts and unlocks.
* A VIEWER cannot elevate: no admin-management route is reachable without `admin:manage`.
