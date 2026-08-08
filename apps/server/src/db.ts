import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type PaymentStatus = "succeeded" | "declined" | "partially_refunded" | "refunded";

export type PaymentEventType =
  | "payment.created"
  | "payment.succeeded"
  | "payment.declined"
  | "refund.created"
  | "payment.refunded";

export interface PaymentRow {
  id: string;
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
    CREATE TABLE IF NOT EXISTS payments (
      id            TEXT PRIMARY KEY,
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

    CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds(payment_id);
    CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id ON payment_events(payment_id);
  `);

  migrate(db);

  return db;
}

/**
 * Brings databases created by earlier versions of the schema up to date.
 * Every step must be safe to run against an already-migrated database.
 */
function migrate(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(payments)`).all() as { name: string }[];

  if (!columns.some((c) => c.name === "amount_refunded")) {
    db.exec(`ALTER TABLE payments ADD COLUMN amount_refunded INTEGER NOT NULL DEFAULT 0`);
    // Payments refunded before partial refunds existed were always refunded in full.
    db.exec(`UPDATE payments SET amount_refunded = amount WHERE status = 'refunded'`);
  }
}
