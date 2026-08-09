# cloud-pay

A full-featured **payments platform demo** built as an npm-workspaces monorepo. It simulates card processing, subscriptions, webhooks, disputes, and payouts entirely offline — no external payment network required.

## Stack

| Part | Tech |
| --- | --- |
| `apps/server` | Node.js + Express + TypeScript, SQLite (`better-sqlite3`), Zod validation |
| `apps/web` | React + Vite + React Router + TypeScript |
| Tests | Vitest + Supertest (server) |
| Lint | ESLint (flat config) + typescript-eslint |

## Features

- **Payments** — card charges, partial/full refunds, idempotency keys, event timelines
- **Customers** — CRM with lifetime value and payment counts
- **Products & prices** — one-time and recurring catalog
- **Subscriptions** — recurring billing with invoices and automatic renewals
- **Webhooks** — signed event delivery with retries and delivery logs
- **Disputes** — chargeback simulation with evidence and resolution
- **Payouts** — merchant balance, fees, and bank transfers
- **Analytics** — daily volume, MRR, brand breakdown, top customers
- **API keys** — Bearer token authentication with key management

## Prerequisites

- Node.js >= 20 (developed against Node 22)
- npm 10+

## Getting started

```bash
npm install          # install all workspaces
npm run dev          # start API (:4000) and web UI (:5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api` to port 4000.

On first boot the server prints a demo API key. Visit **Settings** in the dashboard to save it, or fetch it from `GET /api/setup`.

## Common commands

```bash
npm run dev          # run server + web in parallel (dev mode)
npm run build        # type-check and build server + web
npm test             # run the server test suite (Vitest)
npm run lint         # lint the whole repo
npm run typecheck    # type-check every workspace
```

## API overview

Base URL: `http://localhost:4000/api`

Authentication is optional in development (defaults to the demo merchant). Set `CLOUD_PAY_REQUIRE_AUTH=true` to require `Authorization: Bearer <api_key>` on every request.

| Area | Endpoints |
| --- | --- |
| Payments | `GET/POST /payments`, `GET /payments/:id`, `POST /payments/:id/refund` |
| Customers | `GET/POST /customers`, `GET/PATCH/DELETE /customers/:id` |
| Products | `GET/POST /products`, `GET /products/:id`, `POST /products/:id/prices` |
| Subscriptions | `GET/POST /subscriptions`, `GET /subscriptions/:id`, `POST /subscriptions/:id/cancel` |
| Webhooks | `GET/POST /webhooks`, `DELETE /webhooks/:id`, `GET /webhook-deliveries` |
| Disputes | `GET/POST /disputes`, `GET /disputes/:id`, `POST /disputes/:id/evidence`, `POST /disputes/:id/resolve` |
| Payouts | `GET /balance`, `GET/POST /payouts` |
| Analytics | `GET /analytics?days=30` |
| Admin | `GET/POST/DELETE /api-keys`, `GET /stats`, `GET /health`, `GET /setup` |

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

`amount` is in minor units (cents). Send an `Idempotency-Key` header for safe retries.

### Simulated test cards

| Card number | Outcome |
| --- | --- |
| `4242 4242 4242 4242` | Succeeds |
| `4000 0000 0000 0002` | Declined (`card_declined`) |
| `4000 0000 0000 9995` | Declined (`insufficient_funds`) |
| `4000 0000 0000 0069` | Declined (`expired_card`) |

## Data

SQLite database at `apps/server/data/cloud-pay.sqlite` (override with `CLOUD_PAY_DB`). Tests use an in-memory database.

Tables: `merchants`, `api_keys`, `customers`, `products`, `prices`, `payments`, `refunds`, `payment_events`, `subscriptions`, `subscription_invoices`, `webhook_endpoints`, `webhook_deliveries`, `disputes`, `payouts`, `outbox_events`, `idempotency_keys`.

Background workers process webhook deliveries and subscription renewals automatically.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4000` | API server port |
| `CLOUD_PAY_DB` | `apps/server/data/cloud-pay.sqlite` | Database file path |
| `CLOUD_PAY_REQUIRE_AUTH` | `false` | Require Bearer API key on all requests |
