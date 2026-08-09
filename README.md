# cloud-pay

A small, self-contained **payments demo** built as an npm-workspaces monorepo.
It processes simulated card payments (no external payment network required) so
the full stack can run entirely offline in a development environment.

## Stack

| Part | Tech |
| --- | --- |
| `apps/server` | Node.js + Express + TypeScript, SQLite (`better-sqlite3`), Zod validation |
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

Then open http://localhost:5173. The Vite dev server proxies `/api` to the
API server on port 4000.

## Common commands

```bash
npm run dev          # run server + web in parallel (dev mode)
npm run build        # type-check and build server + web
npm test             # run the server test suite (Vitest)
npm run lint         # lint the whole repo
npm run typecheck    # type-check every workspace
```

Run a single workspace directly:

```bash
npm run dev  --workspace apps/server
npm run dev  --workspace apps/web
npm test     --workspace apps/server
```

## API

Base URL: `http://localhost:4000/api`

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Service health check |
| `GET` | `/stats` | Aggregate volume / counts |
| `GET` | `/payments` | List payments (newest first, searchable and paginated) |
| `POST` | `/payments` | Create (process) a payment |
| `GET` | `/payments/:id` | Fetch a payment with its refunds and event timeline |
| `POST` | `/payments/:id/refund` | Refund a payment in full or in part |

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
    "cardNumber": "4242424242424242"
  }'
```

`amount` is in the currency's minor unit (cents). Card numbers are validated
with the Luhn algorithm.

Send an `Idempotency-Key` header to make retries safe: the first request with a
given key stores its result, and any later request with the same key returns
that original payment instead of charging again. The response carries
`Idempotency-Replayed: true` when it is a replay. Reusing a key with different
parameters is rejected with `409 idempotency_key_reuse`.

```bash
curl -s http://localhost:4000/api/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1234' \
  -d '{ "amount": 2500, "customerName": "Ada Lovelace",
        "customerEmail": "ada@example.com", "cardNumber": "4242424242424242" }'
```

### List, search and paginate

`GET /payments` accepts `status`, `q`, `limit` (1–100, default 25) and `offset`,
and responds with `{ payments, total, limit, offset }`. `q` matches the customer
name, email, description or payment id.

```bash
curl -s 'http://localhost:4000/api/payments?status=partially_refunded&q=ada&limit=10&offset=0'
```

### Refunds

`POST /payments/:id/refund` refunds the whole remaining balance when no body is
sent, or a partial amount with `{ "amount": 1000, "reason": "goodwill" }`. A
payment moves to `partially_refunded` while a balance remains and to `refunded`
once it reaches zero. Refunding more than the remaining balance returns
`400 refund_amount_too_large`, and declined payments cannot be refunded.

Every payment carries an append-only event timeline (`payment.created`,
`payment.succeeded`, `payment.declined`, `refund.created`, `payment.refunded`),
returned alongside the individual refunds by `GET /payments/:id`.

### Simulated test cards

| Card number | Outcome |
| --- | --- |
| `4242 4242 4242 4242` | Succeeds |
| `4000 0000 0000 0002` | Declined (`card_declined`) |
| `4000 0000 0000 9995` | Declined (`insufficient_funds`) |
| `4000 0000 0000 0069` | Declined (`expired_card`) |

## Data

The server persists payments to SQLite at `apps/server/data/cloud-pay.sqlite`
(override with `CLOUD_PAY_DB`). Tests use an in-memory database.

Tables: `payments`, `refunds` (one row per refund), `payment_events` (the
timeline) and `idempotency_keys`. The schema is created on boot and migrated
forward in place, so an existing database file keeps working across upgrades.
