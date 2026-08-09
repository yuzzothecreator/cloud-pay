# cloud-pay

A self-contained **payments platform demo** built as an npm-workspaces monorepo.
It simulates card processing (no external payment network) so the full stack
runs offline in a development environment — with customers, authorize/capture,
refunds, disputes, signed webhooks, API keys, analytics and a multi-page
dashboard.

## Stack

| Part | Tech |
| --- | --- |
| `apps/server` | Node.js + Express + TypeScript, SQLite (`better-sqlite3`), Zod |
| `apps/web` | React + Vite + TypeScript |
| Tests | Vitest + Supertest (server) |
| Lint | ESLint (flat config) + typescript-eslint |

## Prerequisites

- Node.js >= 20 (developed against Node 22)
- npm 10+

## Getting started

```bash
npm install          # install all workspaces
npm run dev          # start API (:4000) and web UI (:5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api` to port 4000.

On first boot the API seeds a sample ledger (customers, payments, an open
dispute, a webhook endpoint and an API key). Disable with `CLOUD_PAY_SEED=0`.

## Common commands

```bash
npm run dev          # run server + web in parallel
npm run build        # type-check and build server + web
npm test             # server test suite (Vitest)
npm run lint         # lint the whole repo
npm run typecheck    # type-check every workspace
```

## Dashboard

Hash-routed pages in the web app:

| Page | What it does |
| --- | --- |
| Payments | Charge / authorise cards, search, filter, capture, refund, dispute, CSV export |
| Customers | Customer directory with lifetime value and payment history |
| Disputes | Chargeback workflow (`needs_response` → `under_review` → `won`/`lost`) |
| Webhooks | Endpoints, HMAC secrets, delivery log and retries |
| Analytics | Daily volume chart, top customers, status breakdown |
| Settings | API key minting / revocation and test-card reference |

## API

Base URL: `http://localhost:4000/api`

### Core

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `GET` | `/stats` | Aggregate volume / counts |
| `GET` | `/analytics?days=14` | Daily series + top customers |
| `GET` | `/payments` | List (`status`, `q`, `customerId`, `limit`, `offset`) |
| `GET` | `/payments/export.csv` | CSV export of the ledger |
| `POST` | `/payments` | Create / process a payment |
| `GET` | `/payments/:id` | Detail with refunds + timeline |
| `POST` | `/payments/:id/refund` | Full or partial refund |
| `POST` | `/payments/:id/capture` | Capture an authorised payment |
| `POST` | `/payments/:id/cancel` | Release an authorisation |
| `POST` | `/payments/:id/disputes` | Open a dispute |

### Customers, disputes, webhooks, keys

| Method | Path | Description |
| --- | --- | --- |
| `GET`/`POST` | `/customers` | List / upsert customers |
| `GET` | `/customers/:id` | Customer detail |
| `GET` | `/disputes` | List disputes |
| `GET`/`PATCH` | `/disputes/:id` | Fetch / update dispute status |
| `GET`/`POST` | `/webhooks/endpoints` | List / create endpoints |
| `PATCH`/`DELETE` | `/webhooks/endpoints/:id` | Update / delete endpoint |
| `GET` | `/webhooks/deliveries` | Delivery log |
| `POST` | `/webhooks/deliveries/:id/retry` | Retry a failed delivery |
| `GET`/`POST` | `/api-keys` | List / create keys |
| `POST` | `/api-keys/:id/revoke` | Revoke a key |

### Create a payment

```bash
curl -s http://localhost:4000/api/payments \
  -H 'Content-Type: application/json' \
  -d '{
    "amount": 2500,
    "currency": "usd",
    "description": "Pro plan",
    "customerName": "Ada Lovelace",
    "customerEmail": "ada@example.com",
    "cardNumber": "4242424242424242",
    "captureMethod": "automatic",
    "metadata": { "orderId": "ord_1" },
    "statementDescriptor": "CLOUDPAY*PRO"
  }'
```

`amount` is in minor units (cents). Cards are Luhn-validated. Customers are
upserted by email and linked onto the payment.

Send `Idempotency-Key` to make retries safe. Replays return
`Idempotency-Replayed: true`. Reusing a key with different parameters yields
`409 idempotency_key_reuse`.

### Authorize & capture

```bash
# Authorise only
curl -s http://localhost:4000/api/payments \
  -H 'Content-Type: application/json' \
  -d '{ ..., "captureMethod": "manual" }'

# Capture (optionally less than authorised)
curl -s http://localhost:4000/api/payments/pay_xxx/capture \
  -H 'Content-Type: application/json' \
  -d '{ "amount": 2000 }'

# Or release the hold
curl -s -X POST http://localhost:4000/api/payments/pay_xxx/cancel
```

### Webhooks

Endpoints receive JSON POSTs signed with HMAC-SHA256:

```
X-Cloud-Pay-Signature: t=<unix>,v1=<hex>
```

where `v1 = HMAC_SHA256(secret, "{t}.{body}")`. Set
`CLOUD_PAY_WEBHOOK_AUTO_DELIVER=1` to deliver immediately in the API process
(off by default so boot seed does not hit the network).

### API keys

```bash
curl -s http://localhost:4000/api/stats \
  -H 'Authorization: Bearer cp_live_...'
```

Optional auth: when a Bearer token is present it is validated. Set
`CLOUD_PAY_REQUIRE_AUTH=1` to reject unauthenticated requests (except `/health`).

### Simulated test cards

| Card number | Outcome |
| --- | --- |
| `4242 4242 4242 4242` | Succeeds |
| `4000 0000 0000 0002` | Declined (`card_declined`) |
| `4000 0000 0000 9995` | Declined (`insufficient_funds`) |
| `4000 0000 0000 0069` | Declined (`expired_card`) |
| `4000 0000 0000 0119` | Declined (`processing_error`) |
| `4000 0000 0000 0259` | Declined (`lost_card`) |

## Data

SQLite at `apps/server/data/cloud-pay.sqlite` (override with `CLOUD_PAY_DB`).
Tests use an in-memory database.

Tables: `customers`, `payments`, `refunds`, `payment_events`, `idempotency_keys`,
`disputes`, `webhook_endpoints`, `webhook_deliveries`, `api_keys`,
`platform_events`. Schema migrates forward in place across upgrades.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | API port |
| `CLOUD_PAY_DB` | `apps/server/data/cloud-pay.sqlite` | SQLite path |
| `CLOUD_PAY_SEED` | on | Seed demo data when the ledger is empty |
| `CLOUD_PAY_REQUIRE_AUTH` | off | Require API keys on `/api/*` |
| `CLOUD_PAY_WEBHOOK_AUTO_DELIVER` | off | Deliver webhooks inline |
