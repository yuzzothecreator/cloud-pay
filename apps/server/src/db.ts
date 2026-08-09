import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { newId } from "./ids.js";

export type PaymentStatus = "succeeded" | "declined" | "partially_refunded" | "refunded";

export type PaymentEventType =
  | "payment.created"
  | "payment.succeeded"
  | "payment.declined"
  | "refund.created"
  | "payment.refunded"
  | "dispute.opened"
  | "dispute.won"
  | "dispute.lost";

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete";

export type DisputeStatus = "needs_response" | "under_review" | "won" | "lost";

export type PayoutStatus = "pending" | "in_transit" | "paid" | "failed" | "canceled";

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

export interface PaymentRow {
  id: string;
  merchant_id: string;
  customer_id: string | null;
  amount: number;
  currency: string;
  description: string;
  customer_name: string;
  customer_email: string;
  card_last4: string;
  card_brand: string;
  status: PaymentStatus;
  failure_reason: string | null;
  amount_refunded: number;
  created_at: string;
}

export interface RefundRow {
  id: string;
  payment_id: string;
  amount: number;
  reason: string;
  created_at: string;
}

export interface PaymentEventRow {
  seq: number;
  id: string;
  payment_id: string;
  type: PaymentEventType;
  message: string;
  created_at: string;
}

export interface IdempotencyRow {
  key: string;
  request_hash: string;
  payment_id: string;
  created_at: string;
}

export interface MerchantRow {
  id: string;
  name: string;
  email: string;
  balance: number;
  currency: string;
  created_at: string;
}

export interface ApiKeyRow {
  id: string;
  merchant_id: string;
  key_hash: string;
  prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface CustomerRow {
  id: string;
  merchant_id: string;
  name: string;
  email: string;
  phone: string;
  metadata_json: string;
  created_at: string;
}

export interface ProductRow {
  id: string;
  merchant_id: string;
  name: string;
  description: string;
  active: number;
  metadata_json: string;
  created_at: string;
}

export interface PriceRow {
  id: string;
  product_id: string;
  unit_amount: number;
  currency: string;
  interval: string | null;
  interval_count: number | null;
  active: number;
  created_at: string;
}

export interface SubscriptionRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  price_id: string;
  status: SubscriptionStatus;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: number;
  latest_payment_id: string | null;
  created_at: string;
}

export interface SubscriptionInvoiceRow {
  id: string;
  subscription_id: string;
  payment_id: string | null;
  amount: number;
  currency: string;
  status: string;
  period_start: string;
  period_end: string;
  created_at: string;
}

export interface WebhookEndpointRow {
  id: string;
  merchant_id: string;
  url: string;
  secret: string;
  enabled_events_json: string;
  active: number;
  created_at: string;
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  event_type: string;
  payload_json: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: string | null;
  response_status: number | null;
  response_body: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface DisputeRow {
  id: string;
  payment_id: string;
  amount: number;
  reason: string;
  status: DisputeStatus;
  evidence_due_by: string;
  created_at: string;
  resolved_at: string | null;
}

export interface PayoutRow {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  arrival_date: string | null;
  created_at: string;
}

export interface OutboxEventRow {
  id: string;
  merchant_id: string;
  type: string;
  payload_json: string;
  processed: number;
  created_at: string;
}

export interface DatabaseContext {
  db: Database.Database;
  defaultMerchantId: string;
  defaultApiKey: string | null;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Opens a SQLite database and ensures the schema exists.
 * Pass ":memory:" for an ephemeral database (used by tests).
 */
export function openDatabase(location: string): DatabaseContext {
  if (location !== ":memory:") {
    mkdirSync(dirname(location), { recursive: true });
  }

  const db = new Database(location);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchants (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      balance    INTEGER NOT NULL DEFAULT 0,
      currency   TEXT NOT NULL DEFAULT 'usd',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      merchant_id  TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      key_hash     TEXT NOT NULL UNIQUE,
      prefix       TEXT NOT NULL,
      name         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS customers (
      id            TEXT PRIMARY KEY,
      merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL,
      phone         TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id            TEXT PRIMARY KEY,
      merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      active        INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prices (
      id             TEXT PRIMARY KEY,
      product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      unit_amount    INTEGER NOT NULL,
      currency       TEXT NOT NULL,
      interval       TEXT,
      interval_count INTEGER,
      active         INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id            TEXT PRIMARY KEY,
      merchant_id   TEXT NOT NULL DEFAULT 'mer_default' REFERENCES merchants(id),
      customer_id   TEXT REFERENCES customers(id) ON DELETE SET NULL,
      amount        INTEGER NOT NULL,
      currency      TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      card_last4    TEXT NOT NULL,
      card_brand    TEXT NOT NULL,
      status        TEXT NOT NULL,
      failure_reason TEXT,
      amount_refunded INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id         TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      amount     INTEGER NOT NULL,
      reason     TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_events (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      id         TEXT NOT NULL UNIQUE,
      payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key          TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      payment_id   TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id                   TEXT PRIMARY KEY,
      merchant_id          TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      customer_id          TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      price_id             TEXT NOT NULL REFERENCES prices(id),
      status               TEXT NOT NULL,
      current_period_start TEXT NOT NULL,
      current_period_end   TEXT NOT NULL,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      latest_payment_id    TEXT REFERENCES payments(id),
      created_at           TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscription_invoices (
      id              TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      payment_id      TEXT REFERENCES payments(id),
      amount          INTEGER NOT NULL,
      currency        TEXT NOT NULL,
      status          TEXT NOT NULL,
      period_start    TEXT NOT NULL,
      period_end      TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id                  TEXT PRIMARY KEY,
      merchant_id         TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      url                 TEXT NOT NULL,
      secret              TEXT NOT NULL,
      enabled_events_json TEXT NOT NULL DEFAULT '["*"]',
      active              INTEGER NOT NULL DEFAULT 1,
      created_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id              TEXT PRIMARY KEY,
      endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      event_type      TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      status          TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      response_status INTEGER,
      response_body   TEXT,
      created_at      TEXT NOT NULL,
      delivered_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS disputes (
      id              TEXT PRIMARY KEY,
      payment_id      TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      amount          INTEGER NOT NULL,
      reason          TEXT NOT NULL,
      status          TEXT NOT NULL,
      evidence_due_by TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      resolved_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS payouts (
      id           TEXT PRIMARY KEY,
      merchant_id  TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      amount       INTEGER NOT NULL,
      currency     TEXT NOT NULL,
      status       TEXT NOT NULL,
      arrival_date TEXT,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox_events (
      id           TEXT PRIMARY KEY,
      merchant_id  TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      type         TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      processed    INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds(payment_id);
    CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id ON payment_events(payment_id);
    CREATE INDEX IF NOT EXISTS idx_customers_merchant ON customers(merchant_id);
    CREATE INDEX IF NOT EXISTS idx_products_merchant ON products(merchant_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_outbox_processed ON outbox_events(processed, created_at);
    CREATE INDEX IF NOT EXISTS idx_disputes_payment ON disputes(payment_id);
  `);

  migrate(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id);
    CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
  `);
  const { defaultMerchantId, defaultApiKey } = seedDefaults(db);

  return { db, defaultMerchantId, defaultApiKey };
}

function seedDefaults(db: Database.Database): { defaultMerchantId: string; defaultApiKey: string | null } {
  const existing = db.prepare(`SELECT id FROM merchants LIMIT 1`).get() as { id: string } | undefined;
  if (existing) {
    return { defaultMerchantId: existing.id, defaultApiKey: null };
  }

  const merchantId = "mer_default";
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO merchants (id, name, email, balance, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(merchantId, "Cloud Pay Demo", "demo@cloud-pay.dev", 0, "usd", createdAt);

  const rawKey = `cpk_live_${randomBytes(24).toString("hex")}`;
  const prefix = rawKey.slice(0, 12);
  db.prepare(
    `INSERT INTO api_keys (id, merchant_id, key_hash, prefix, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(newId("key"), merchantId, hashApiKey(rawKey), prefix, "Default demo key", createdAt);

  return { defaultMerchantId: merchantId, defaultApiKey: rawKey };
}

function migrate(db: Database.Database): void {
  ensureMerchantsTable(db);

  const paymentColumns = db.prepare(`PRAGMA table_info(payments)`).all() as { name: string }[];

  if (!paymentColumns.some((c) => c.name === "amount_refunded")) {
    db.exec(`ALTER TABLE payments ADD COLUMN amount_refunded INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE payments SET amount_refunded = amount WHERE status = 'refunded'`);
  }

  if (!paymentColumns.some((c) => c.name === "merchant_id")) {
    ensureMerchantsTable(db);
    db.exec(`ALTER TABLE payments ADD COLUMN merchant_id TEXT NOT NULL DEFAULT 'mer_default'`);
  }

  if (!paymentColumns.some((c) => c.name === "customer_id")) {
    db.exec(`ALTER TABLE payments ADD COLUMN customer_id TEXT`);
  }
}

function ensureMerchantsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchants (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      balance    INTEGER NOT NULL DEFAULT 0,
      currency   TEXT NOT NULL DEFAULT 'usd',
      created_at TEXT NOT NULL
    );
  `);
  const existing = db.prepare(`SELECT id FROM merchants WHERE id = 'mer_default'`).get();
  if (!existing) {
    db.prepare(
      `INSERT INTO merchants (id, name, email, balance, currency, created_at)
       VALUES ('mer_default', 'Cloud Pay Demo', 'demo@cloud-pay.dev', 0, 'usd', ?)`,
    ).run(new Date().toISOString());
  }
}
