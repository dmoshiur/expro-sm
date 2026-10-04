# Documentation

| File | Contents |
| --- | --- |
| [`permissions.md`](./permissions.md) | Role matrix, permission keys and the complete route → permission map |
| [`payment-flow.md`](./payment-flow.md) | Payment links, bKash Tokenized Checkout, verification, settlement, reconciliation, receipts, state machines |
| [`openapi.yaml`](./openapi.yaml) | OpenAPI 3.0 description of the whole API (import into Postman/Insomnia or Swagger UI) |
| [`postman_collection.json`](./postman_collection.json) | Ready-to-run Postman collection: login → investors → investments → links → manual payment → reports → audit |

## Try the API in 60 seconds

```bash
cd server && npx tsx server.ts        # API on :4000 (dev database already migrated + seeded)

# 1. sign in (cookie jar)
curl -s -c /tmp/ip.txt -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@investorportal.local","password":"Admin@12345"}'

# 2. dashboard
curl -s -b /tmp/ip.txt http://localhost:4000/api/dashboard | head -c 400

# 3. create an investor + investment, then send a link
#    (see docs/postman_collection.json for the full happy path)
```

With the default configuration (`SMS_PROVIDER=console`, no bKash credentials) SMS bodies are printed
to the API log and payments run through the deterministic mock gateway — ideal for demos and CI.

For the browser: `npm run dev` starts the API on :4000 and the SPA on :5173 (Vite proxies `/api`).
