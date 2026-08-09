import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type PaymentStatus =
  | "requires_capture"
  | "succeeded"
  | "declined"
  | "partially_refunded"
  | "refunded"
  | "canceled";

export type CaptureMethod = "automatic" | "manual";

export type PaymentEventType =
  | "payment.created"
  | "payment.authorized"
  | "payment.succeeded"
  | "payment.captured"
  | "payment.declined"
  | "payment.canceled"
  | "refund.created"
  | "payment.refunded"
  | "dispute.created"
  | "dispute.updated"
  | "customer.created"
  | "customer.updated";

export type DisputeStatus = "needs_response" | "under_review" | "won" | "lost" | "withdrawn";

export type DisputeReason =
  | "fraudulent"
  | "product_not_received"
  | "product_unacceptable"
  | "duplicate"
  | "subscription_canceled"
  | "unrecognized"
  | "general";

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

export interface PaymentRow {
  id: string;
  amount: number;
  currency: string;
  description: string;
  customer_id: string | null;
  customer_name: string;
  customer_email: string;
  card_last4: string;
  card_brand: string;
  status: PaymentStatus;
  failure_reason: string | null;
  amount_refunded: number;
  amount_capturable: number;
  capture_method: CaptureMethod;
  metadata: string;
  statement_descriptor: string;
  created_at: string;
  updated_at: string;
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

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface DisputeRow {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  reason: DisputeReason;
  status: DisputeStatus;
  evidence: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookEndpointRow {
  id: string;
  url: string;
  secret: string;
  description: string;
  enabled: number;
  events: string;
  created_at: string;
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_error: string | null;
  response_status: number | null;
  created_at: string;
  delivered_at: string | null;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  key_hash: string;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface PlatformEventRow {
  seq: number;
  id: string;
  type: string;
  object_type: string;
  object_id: string;
  payload: string;
  created_at: string;
}

/**
 * Opens a SQLite database and ensures the schema exists.
 * Pass ":memory:" for an ephemeral database (used by tests).
 */
export function openDatabase(location: string): Database.Database {
  if (location !== ":memory:") {
    mkdirSync(dirname(location), { recursive: true });
  }

  const db = new Database(location);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      phone      TEXT NOT NULL DEFAULT '',
      metadata   TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id            TEXT PRIMARY KEY,
      amount        INTEGER NOT NULL,
      currency      TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      customer_id   TEXT REFERENCES customers(id),
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      card_last4    TEXT NOT NULL,
      card_brand    TEXT NOT NULL,
      status        TEXT NOT NULL,
      failure_reason TEXT,
      amount_refunded INTEGER NOT NULL DEFAULT 0,
      amount_capturable INTEGER NOT NULL DEFAULT 0,
      capture_method TEXT NOT NULL DEFAULT 'automatic',
      metadata      TEXT NOT NULL DEFAULT '{}',
      statement_descriptor TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT ''
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

    CREATE TABLE IF NOT EXISTS disputes (
      id         TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      amount     INTEGER NOT NULL,
      currency   TEXT NOT NULL,
      reason     TEXT NOT NULL,
      status     TEXT NOT NULL,
      evidence   TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id          TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      secret      TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      events      TEXT NOT NULL DEFAULT '["*"]',
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id              TEXT PRIMARY KEY,
      endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      event_id        TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      payload         TEXT NOT NULL,
      status          TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      response_status INTEGER,
      created_at      TEXT NOT NULL,
      delivered_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      prefix       TEXT NOT NULL,
      key_hash     TEXT NOT NULL,
      last_used_at TEXT,
      created_at   TEXT NOT NULL,
      revoked_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS platform_events (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      id          TEXT NOT NULL UNIQUE,
      type        TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id   TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);

  // Bring legacy payment tables forward before creating indexes that depend on
  // columns introduced in later schema versions.
  migrate(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_customer_id ON payments(customer_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds(payment_id);
    CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id ON payment_events(payment_id);
    CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
    CREATE INDEX IF NOT EXISTS idx_disputes_payment_id ON disputes(payment_id);
    CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id);
    CREATE INDEX IF NOT EXISTS idx_platform_events_type ON platform_events(type);
  `);

  return db;
}

/**
 * Brings databases created by earlier versions of the schema up to date.
 * Every step must be safe to run against an already-migrated database.
 */
function migrate(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(payments)`).all() as { name: string }[];
  const names = new Set(columns.map((c) => c.name));

  if (!names.has("amount_refunded")) {
    db.exec(`ALTER TABLE payments ADD COLUMN amount_refunded INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE payments SET amount_refunded = amount WHERE status = 'refunded'`);
  }
  if (!names.has("customer_id")) {
    db.exec(`ALTER TABLE payments ADD COLUMN customer_id TEXT REFERENCES customers(id)`);
  }
  if (!names.has("amount_capturable")) {
    db.exec(`ALTER TABLE payments ADD COLUMN amount_capturable INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has("capture_method")) {
    db.exec(`ALTER TABLE payments ADD COLUMN capture_method TEXT NOT NULL DEFAULT 'automatic'`);
  }
  if (!names.has("metadata")) {
    db.exec(`ALTER TABLE payments ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`);
  }
  if (!names.has("statement_descriptor")) {
    db.exec(`ALTER TABLE payments ADD COLUMN statement_descriptor TEXT NOT NULL DEFAULT ''`);
  }
  if (!names.has("updated_at")) {
    db.exec(`ALTER TABLE payments ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE payments SET updated_at = created_at WHERE updated_at = ''`);
  }
}
