import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type PaymentStatus = "succeeded" | "declined" | "refunded";

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
      created_at    TEXT NOT NULL
    );
  `);

  return db;
}
