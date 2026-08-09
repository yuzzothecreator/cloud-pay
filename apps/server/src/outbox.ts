import type Database from "better-sqlite3";
import { newId } from "./ids.js";

export interface OutboxPayload {
  type: string;
  merchantId: string;
  data: Record<string, unknown>;
}

export class OutboxService {
  constructor(private readonly db: Database.Database) {}

  publish(event: OutboxPayload): string {
    const id = newId("evt");
    this.db
      .prepare(
        `INSERT INTO outbox_events (id, merchant_id, type, payload_json, processed, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(id, event.merchantId, event.type, JSON.stringify(event.data), new Date().toISOString());
    return id;
  }

  claimBatch(limit = 20): { id: string; merchantId: string; type: string; data: Record<string, unknown> }[] {
    const rows = this.db
      .prepare(
        `SELECT id, merchant_id, type, payload_json FROM outbox_events
         WHERE processed = 0 ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as { id: string; merchant_id: string; type: string; payload_json: string }[];

    return rows.map((r) => ({
      id: r.id,
      merchantId: r.merchant_id,
      type: r.type,
      data: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));
  }

  markProcessed(id: string): void {
    this.db.prepare(`UPDATE outbox_events SET processed = 1 WHERE id = ?`).run(id);
  }
}
