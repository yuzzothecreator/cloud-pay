import type Database from "better-sqlite3";
import type { PaymentEventType } from "../db.js";
import { prefixedId } from "../lib/ids.js";

export type EventBusListener = (event: {
  id: string;
  type: string;
  objectType: string;
  objectId: string;
  payload: unknown;
  createdAt: string;
}) => void;

/**
 * Records payment-scoped timeline rows and platform-wide events that webhook
 * endpoints can subscribe to.
 */
export class EventBus {
  private listeners = new Set<EventBusListener>();

  constructor(private readonly db: Database.Database) {}

  on(listener: EventBusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recordPaymentEvent(paymentId: string, type: PaymentEventType, message: string): string {
    const id = prefixedId("evt");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO payment_events (id, payment_id, type, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, paymentId, type, message, createdAt);
    return id;
  }

  emitPlatform(
    type: string,
    objectType: string,
    objectId: string,
    payload: unknown,
  ): { id: string; createdAt: string } {
    const id = prefixedId("evt");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO platform_events (id, type, object_type, object_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, type, objectType, objectId, JSON.stringify(payload), createdAt);

    for (const listener of this.listeners) {
      try {
        listener({ id, type, objectType, objectId, payload, createdAt });
      } catch (err) {
        console.error("Event listener failed:", err);
      }
    }

    return { id, createdAt };
  }
}
