# Payment flow (payment links + bKash)

The portal never trusts a browser about money. An installment only becomes
`PAID` after the **server** re-executes/re-queries the gateway and verifies the
amount, the invoice number and the transaction id inside one database
transaction.

## 1. Issuing a link

```
admin ──POST /api/installments/:id/pay-link { regenerate?: boolean } ──▶ server
                                                                          │
        token = base64url(32 random bytes)  ─────────────────────────────┤
        store sha256(token) + expiry (PAYMENT_LINK_TTL_DAYS)  ────────────┤
        audit PAY_LINK_GENERATED | PAY_LINK_REGENERATED  ────────────────┘
        returns { url, token }  ← the raw token is returned exactly once
```

* Only the SHA-256 hash is stored (`installments.pay_token_hash`), so a database
  leak cannot be used to open a payment page, and a link cannot be re-derived.
* There is exactly one live link per installment: issuing a new one (or letting
  `POST /api/installments/:id/send-link` / the reminder job issue one) invalidates
  the previous URL immediately and bumps `token_version`.
* Audit labels are factual: a first-ever (or post-expiry) issuance is
  `PAY_LINK_GENERATED`; replacing a still-live link is `PAY_LINK_REGENERATED`
  with the old token version in `old_value`.
* The reminder job cannot re-send an old URL (only the hash exists), so each
  reminder mints a fresh token — the newest SMS always holds the working link.

## 2. Investor opens `/pay/<token>`

`GET /api/public/pay/:token` returns the minimal projection, nothing else:

```json
{ "firstName": "Shahriar", "installmentNumber": 3, "installmentCount": 12,
  "amount": 125000, "amountPaid": 0, "dueDate": "2026-11-30",
  "status": "PENDING", "overdue": false, "settled": false, "canPay": true,
  "mobileHint": "0171*****77", "businessName": "Investor Installment Portal" }
```

No full name, no full mobile, no NID, no investment/investor ids, no amounts of
other installments. Invalid tokens and expired tokens both fail closed:

| Case | Status | Code |
| --- | --- | --- |
| Unknown / malformed / superseded token | `404` | `LINK_INVALID` |
| Token past `token_expires_at` | `410` | `LINK_EXPIRED` |

Both are rate-limited (`payLimiter`) and audited (`PAY_LINK_ACCESSED`,
`PAY_LINK_INVALID`), and the message shown to the investor is generic.

## 3. Paying

```
investor ──POST /api/public/pay/:token/start──▶ server
                                                │  - refuses settled/waived/cancelled installments (409)
                                                │  - reuses an open attempt from the last 60s (double-click guard)
                                                │  - gateway.createPayment({ amountPoisha, invoiceNumber, callbackUrl })
                                                │  - insert payments row: INITIATED, method BKASH, operation_id
                                                │  - audit PAYMENT_INITIATED
                                                ▼
                                       { redirectUrl } → bKash hosted checkout
                                                │
investor completes/cancels at bKash, bKash redirects the browser to
   GET /pay/callback?link=<token>&paymentID=…&status=<whatever bKash felt like>
                                                │
              server IGNORES every query parameter except link + paymentID
                                                ▼
```

`handleCallback` → `executePayment` (bKash "execute" is idempotent) →
`settleFromGateway`, which:

1. `FAILED` / `CANCELLED` → the payment row is terminal, the installment stays
   open and the investor may retry with the same link.
2. `PENDING` / unknown → the row is parked as `PENDING` (callback may arrive
   later or reconciliation will pick it up).
3. `SUCCESS` → inside **one** transaction: lock the payment row (`select … for
   update`), refuse to resurrect a terminal row from a callback, reject a
   duplicate `trx_id` (partial unique index `payments_gateway_trx_unique` is the
   hard guard), then:
   * `payments.status = 'SUCCESS'`, `trx_id`, `verified_at`, `paid_at`;
   * `installments.amount_paid += amount`, status `PARTIALLY_PAID` or `PAID`;
   * every sibling `INITIATED`/`PENDING` attempt for that installment → `CANCELLED`
     ("superseded by a successful payment");
   * audit `PAYMENT_VERIFIED` (with the source: `CALLBACK`, `STATUS_QUERY`,
     `RECONCILE`, `WEBHOOK`).

Verification rules before any money is credited — all from the gateway response,
never from the request:

* `amount` must equal the amount we asked for (`AMOUNT_MISMATCH` → `FAILED`);
* `merchantInvoiceNumber` must match our invoice number (`INVOICE_MISMATCH` → `FAILED`);
* a `trxID` must be present, and must not already exist for this gateway
  (`DUPLICATE_TRX` → the attempt is `FAILED` and audited).

The callback always ends in a `303` redirect to the SPA result page
`/pay/<token>/result?state=success|pending|failed|cancelled|error&ref=&paymentID=`,
so a refresh or a replayed callback is harmless: the second call finds the
payment already settled and returns the same state without touching money.

The result page calls `POST /api/public/pay/:token/verify` which re-queries the
gateway and returns the server's own view (`state`, payment summary, installment
status) — the `state=` query parameter is only a first-paint hint.

## 4. States

`payments.status`: `INITIATED → PENDING → SUCCESS | FAILED | CANCELLED` (plus
`REFUNDED`, reserved for offline refunds recorded by hand).

`installments.status`: `PENDING | PARTIALLY_PAID | PAID | OVERDUE | WAIVED |
CANCELLED`. `OVERDUE` is derived from `due_date < today(Dhaka)` for open
installments and written by the daily sweep; `PAID`/`WAIVED`/`CANCELLED` are
terminal and cannot be paid through a link.

Partial money is possible only through **manual** entries
(`POST /api/payments/manual` with method `CASH | BANK | OTHER`, a reference and
an optional note). A manual entry settles immediately (the money is already in
hand), moves the installment to `PARTIALLY_PAID`/`PAID`, and is reversible: an
accountant may void it (`POST /api/payments/:id/cancel`), which reverses
`amount_paid` inside the same transaction and audits `PAYMENT_CANCELLED`.

## 5. Reconciliation & reminders (in-process, no cron)

| Job | Schedule (Asia/Dhaka) | What it does |
| --- | --- | --- |
| `installments.overdue` | daily `JOB_OVERDUE_AT` | flips open installments past their due date to `OVERDUE` (idempotent, audited once per transition) |
| `reminders.sms` | daily `JOB_REMINDERS_AT` | due-in-`REMINDER_DAYS_BEFORE` and overdue reminders, capped at 100/run and throttled per installment by `OVERDUE_REMINDER_INTERVAL_HOURS` |
| `payments.reconcile` | every `JOB_RECONCILE_EVERY_MINUTES` | re-queries gateway payments stuck in `INITIATED`/`PENDING` for more than `RECONCILE_STUCK_AFTER_MINUTES` (25/batch) and cancels attempts abandoned for 24h |
| `housekeeping` | daily 03:15 | revokes expired sessions, purges old rows, completes investments whose installments are all settled |

Every run is claimed with a deterministic key (`daily-<date>`,
`w-<date>-<window>`) inserted into `job_runs` with `on conflict do nothing`, so a
restart (or a missed tick) runs each unit of work exactly once; a crashed run is
retried because `FAILED` rows are removed on the next attempt. Jobs never throw
into the HTTP layer: a failure is logged, stored on the row and retried. A Super
Admin can trigger any job from `/api/jobs` → *Run now*.

## 6. bKash sandbox → live

`PAYMENT_PROVIDER=bkash` switches the adapter in
`server/src/services/gateways/bkash.gateway.js`:

* `POST /tokenized/checkout/token/grant` — cached (`token` + `expires_in`, refreshed 60s early);
* `POST /tokenized/checkout/create` → `bkashURL` (the URL stored as
  `raw_response.bkashURL` so a double click reuses the same attempt);
* `POST /tokenized/checkout/execute` and `/payment/query` for settlement/rechecks;
* amount, invoice and `trxID` are compared against our own records before anything is credited.

Sandbox values (`.env`):

```
PAYMENT_PROVIDER=bkash
BKASH_MODE=sandbox
BKASH_BASE_URL=https://tokenized.sandbox.bka.sh/v1.2.0-beta
BKASH_APP_KEY=… BKASH_APP_SECRET=… BKASH_USERNAME=… BKASH_PASSWORD=…
PUBLIC_BASE_URL=https://your-domain.example   # used to build the callback URL
```

Test credentials come from the bKash developer portal; the callback URL must be
publicly reachable over HTTPS for the live/sandbox flow to come back. With
`PAYMENT_PROVIDER=mock` (the default) the whole flow above runs against an
in-process fake, which is how the automated tests cover it.

## 7. Donations (welfare funds)

Donations use the same gateway, but they have their own table (`donations`,
migration `004_donations.sql`). They never change installments, investments or
the investor's wallet.

**States:** `INITIATED → PENDING → SUCCESS | FAILED | CANCELLED`. `SUCCESS`,
`FAILED` and `CANCELLED` are terminal. A settled donation is never flipped to
another state by a later verify or reconcile run.

1. **Start** — `POST /api/portal/donations { fundCode, amount }`. The server
   checks the fund and amount (৳10 to ৳5,00,000, stored as integer poisha),
   refuses frozen accounts, and creates the row as `INITIATED`. It then creates
   the gateway payment with the invoice number set to the receipt number
   (`DON-<year>-<id padded to 6>`, Dhaka calendar year). The row becomes
   `PENDING` with `gateway_payment_id`, and the browser is sent to the gateway
   redirect URL. A double-click within 60 seconds reuses the open attempt.
2. **Callback** — the gateway returns to `/pay/callback?kind=donation&paymentID=…`.
   The browser's query values are ignored. The server executes the payment with
   the gateway, then checks that:
   * the amount equals the donation amount,
   * the invoice equals the receipt number,
   * the transaction id is not already used in `payments` or `donations`.

   It then writes `SUCCESS` and the `DONATION_PAID` audit row in one transaction,
   holding a row lock. A mismatch ends in `FAILED` with the reason recorded.
3. **Transient errors** — if the gateway is unreachable during the callback, the
   row stays `PENDING`. The investor can press *Check status*
   (`POST /api/portal/donations/:id/verify`), and the reconcile job re-queries
   stuck rows. Both use the gateway's `queryPayment`, never the browser's claim.
4. **Receipts** — `GET /api/portal/donations/:id/receipt` renders the receipt
   on demand from the stored row: receipt number, fund, amount, transaction id,
   paid time, investor name and member code. Only `SUCCESS` donations have a
   receipt. Each view is audited as `DONATION_RECEIPT_VIEWED`.

Staff see donations read-only at `/donations` (`GET /api/donations`). The list
shows investor name and member code, never a mobile number.
