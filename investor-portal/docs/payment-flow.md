# Payment flow

Covers bKash Tokenized Checkout end to end: how a link becomes money in the database, what is
verified before an installment is marked paid, and what happens when the gateway, the network or the
investor misbehaves.

## 1. Payment link

```
POST /api/payments/installments/:id/link/send        (paymentlink:send)
POST /api/payments/installments/:id/link/regenerate  (paymentlink:regenerate)
POST /api/payments/investments/:id/links/send        (paymentlink:send, bulk)
```

* Token = `crypto.randomBytes(32).toString('base64url')` (~43 chars, 256 bits of entropy).
* Only `sha256(token)` is stored in `installments.payTokenHash` (unique index); the raw token exists
  solely in the SMS and in the URL the investor opens. A database dump therefore cannot be used to
  call payment links.
* `tokenExpiresAt` is set from the `payment_link_ttl_days` setting (default 7 days, env fallback).
* Regenerating overwrites the hash, so the previous link dies instantly.
* Links are not served when the installment is `PAID`, `WAIVED` or `CANCELLED`, the investment is
  cancelled, or the investor is inactive — all of those return the *same* 404 as an unknown token.
* The daily `token-cleanup` job also clears hashes whose expiry has passed (defence in depth).

**Trade-off:** because only the hash is kept, a reminder cannot re-send the original link. Each
reminder mints a fresh token, which invalidates the older SMS. The new SMS always carries a working
link, and the audit trail records every send and regeneration.

## 2. Investor opens `/pay/:token`

```
GET /api/public/payments/:token      (rate limited, no session)
```

Response (deliberately minimal):

```json
{
  "firstName": "Karim",
  "installmentSerial": 2,
  "installmentCount": 6,
  "amount": "125000",
  "amountLabel": "৳ 1,250",
  "dueDate": "12 Oct 2026",
  "status": "PENDING",
  "isOverdue": false,
  "alreadyPaid": false
}
```

No mobile number, no NID, no address, no investor list, no investment id. Unknown, expired, already
paid and waived tokens all produce an identical generic 404 so the endpoint cannot be used to probe
for valid tokens.

## 3. Start the gateway session

```
POST /api/public/payments/:token/start
```

1. `resolveToken()` looks the hash up and rejects anything not payable.
2. **The amount comes from the database** (`installment.amount - paidAmount`), never from the request.
3. A recent (< 30 min) `INITIATED`/`PENDING` payment for the same installment and amount is reused —
   its redirect URL is recovered from `rawResponse`, so a double click does not create a second
   gateway session. If no URL was stored, a fresh session is opened instead of sending the payer
   nowhere.
4. A `Payment` row is created as `INITIATED` (then `PENDING` once the gateway returns a
   `paymentID`), with `gatewayPaymentId` and the raw gateway response stored for support.
5. `audit_logs` gets `payment.initiated` (no card/wallet data, no PII beyond ids and amount).

The response contains `{ paymentId, redirectUrl, gatewayPaymentId, amount, gatewayLive }`; the SPA
navigates to `redirectUrl` (bKash's `bkashURL`).

## 4. Callback (the only path that can mark money received)

```
GET /api/public/payments/bkash/callback?paymentID=…&status=…
```

The query string is treated as a hint only:

1. `paymentID` must match a `Payment` we created — otherwise 404 (and a warning log).
2. If the payment is already `SUCCESS` / `FAILED` / `CANCELLED`, the stored outcome is returned
   (idempotent; a duplicate callback cannot credit an installment twice).
3. Otherwise the gateway is queried (`queryPayment`) and, if it is authorised but not completed,
   `executePayment` captures it.
4. `verifyTransaction()` requires **all** of:
   * gateway status `Completed`
   * a non-empty `trxID`
   * amount equal to our `Payment.amount` (poisha, exact)
   * `merchantInvoiceNumber` equal to `INV-<paymentId>` when the gateway returns one
5. Any failure marks the payment `FAILED` (or `CANCELLED` when the payer cancelled) with the reason,
   and the investor lands on `/pay/result?status=…`. The installment is untouched, so the link can be
   tried again.
6. Unreachable gateway → the callback returns the payment as `PENDING` and the reconciliation job
   finishes the job later.

## 5. Settlement (one transaction)

```sql
UPDATE payments SET status='SUCCESS', trx_id=…, completed_at=now()
 WHERE id=$1 AND status IN ('INITIATED','PENDING');   -- the claim
```

* `count = 0` ⇒ somebody else already settled it → no-op (`alreadySettled`).
* Otherwise, **inside the same transaction**: assign a unique `receiptNumber`
  (`RC-YYYYMM-XXXXXX`), credit the installment (capped at the outstanding amount — an over-payment is
  flagged in the audit trail for a manual refund and can never push `paidAmount` above `amount`),
  set `PAID`/`PARTIALLY_PAID`, stamp `paidAt`, and clear the payment token once the installment is
  fully paid.
* `audit_logs` gets `payment.succeeded` with the credited amount, receipt number, status change and
  the source (`callback` / `reconciliation` / `webhook`).
* After the transaction commits, the investment status is recalculated (completed when every payable
  installment is settled).

A unique index on `payments(gateway, trx_id)` (where `trx_id IS NOT NULL`) is the second line of
defence: if the gateway ever hands back a transaction id we already recorded, the settle transaction
aborts, the payment is marked `FAILED` with “Duplicate gateway transaction id …”, and the duplicate
is left for manual review instead of double-crediting anybody.

## 6. Reconciliation

`reconcile-payments` runs every 15 minutes (Asia/Dhaka):

| Gateway says | Action |
| --- | --- |
| `Completed` and verification passes | settle exactly like a callback (`payment.reconciled` audit row) |
| `Completed` but verification fails (amount/invoice/trx) | mark `FAILED` with the reason |
| `Failed` / `Cancelled` / `Refunded` | mark `FAILED` (no installment change) |
| Anything else | leave it `PENDING` and try again next tick |

Only payments older than 10 minutes and in `INITIATED`/`PENDING` are considered, so a live checkout is
never disturbed.

## 7. Webhook (optional)

`POST /api/public/payments/bkash/webhook` is disabled unless `BKASH_WEBHOOK_ENABLED=true`; when
enabled it also requires `BKASH_WEBHOOK_SECRET` in the `x-bkash-signature` header if a secret is
configured. The payload is **never** trusted: the payment id is looked up and re-verified with the
gateway, exactly like the browser callback.

## 8. Manual payments

```
POST /api/payments/installments/:id/manual     (payment:manual)
{ "amount": "1500.00", "method": "BANK", "reference": "SLIP-99321", "note": "…" }
```

* `method` ∈ `CASH` | `BANK` | `OTHER`; a reference of at least three characters is mandatory.
* Amount defaults to the full outstanding balance and can never exceed it (422 otherwise).
* Creates a `SUCCESS` payment with `gateway = MANUAL`, a receipt number, the recording admin and a
  `payment.manual_recorded` audit entry, then updates the installment in the same transaction.

## 9. Receipts

`GET /api/payments/:id/receipt.pdf` (`payment:read`) streams a PDF with the company header, receipt
number and date, investor (masked mobile), installment, amount in figures **and words**, gateway
reference and a signature line. Downloads are audited (`receipt.downloaded`). Only `SUCCESS`
payments have a receipt (409 otherwise).

## 10. State machine

```
Payment:     INITIATED ─▶ PENDING ─┬─▶ SUCCESS ─▶ (REFUNDED, manual)
                                   ├─▶ FAILED
                                   └─▶ CANCELLED
Installment: PENDING ─┬─▶ PARTIALLY_PAID ─▶ PAID
                      ├─▶ OVERDUE ─▶ (PARTIALLY_PAID │ PAID)
                      ├─▶ WAIVED          (super admin/accountant + reason)
                      └─▶ CANCELLED       (reason)
Investment:  ACTIVE ─▶ COMPLETED (all payable installments settled) │ CANCELLED
```

Overdue is derived in two ways: the nightly job flips `PENDING`/`PARTIALLY_PAID` rows whose due date
has passed, and the serializer additionally computes `isOverdue`/`daysOverdue` at read time so the UI
is correct even between two job runs.
