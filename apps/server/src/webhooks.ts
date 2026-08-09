import type Database from "better-sqlite3";
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { WebhookDeliveryRow, WebhookEndpointRow } from "./db.js";
import { AppError } from "./errors.js";
import { newId } from "./ids.js";
import type { OutboxService } from "./outbox.js";

const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const createWebhookSchema = z.object({
  url: z.string().url(),
  enabledEvents: z.array(z.string()).default(["*"]),
});

export const listDeliveriesQuerySchema = z.object({
  endpointId: z.preprocess(blankToUndefined, z.string().optional()),
  status: z.preprocess(blankToUndefined, z.string().optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(25)),
  offset: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
});

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  enabledEvents: string[];
  active: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

function rowToEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    secret: row.secret,
    enabledEvents: JSON.parse(row.enabled_events_json) as string[],
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

function rowToDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export class WebhookService {
  constructor(
    private readonly db: Database.Database,
    private readonly outbox: OutboxService,
  ) {}

  create(merchantId: string, input: CreateWebhookInput): WebhookEndpoint {
    const id = newId("we");
    const secret = `whsec_${randomBytes(24).toString("hex")}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO webhook_endpoints
          (id, merchant_id, url, secret, enabled_events_json, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(id, merchantId, input.url, secret, JSON.stringify(input.enabledEvents), createdAt);
    return rowToEndpoint(
      this.db.prepare(`SELECT * FROM webhook_endpoints WHERE id = ?`).get(id) as WebhookEndpointRow,
    );
  }

  list(merchantId: string) {
    const rows = this.db
      .prepare(`SELECT * FROM webhook_endpoints WHERE merchant_id = ? ORDER BY created_at DESC`)
      .all(merchantId) as WebhookEndpointRow[];
    return rows.map(rowToEndpoint);
  }

  delete(merchantId: string, id: string): void {
    const result = this.db
      .prepare(`DELETE FROM webhook_endpoints WHERE id = ? AND merchant_id = ?`)
      .run(id, merchantId);
    if (result.changes === 0) {
      throw new AppError(404, "Webhook endpoint not found", "webhook_not_found");
    }
  }

  listDeliveries(merchantId: string, query: ListDeliveriesQuery) {
    const filters = ["e.merchant_id = @merchantId"];
    const params: Record<string, unknown> = { merchantId };
    if (query.endpointId) {
      filters.push("d.endpoint_id = @endpointId");
      params.endpointId = query.endpointId;
    }
    if (query.status) {
      filters.push("d.status = @status");
      params.status = query.status;
    }
    const where = `WHERE ${filters.join(" AND ")}`;
    const { total } = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id = d.endpoint_id ${where}`,
      )
      .get(params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT d.* FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id = d.endpoint_id
         ${where}
         ORDER BY d.created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit, offset: query.offset }) as WebhookDeliveryRow[];

    return {
      deliveries: rows.map(rowToDelivery),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /** Fan out an outbox event to matching webhook endpoints. */
  enqueueFromOutbox(merchantId: string, eventType: string, data: Record<string, unknown>): void {
    const endpoints = this.db
      .prepare(`SELECT * FROM webhook_endpoints WHERE merchant_id = ? AND active = 1`)
      .all(merchantId) as WebhookEndpointRow[];

    const payload = { id: newId("wh"), type: eventType, created: new Date().toISOString(), data };
    const createdAt = new Date().toISOString();

    for (const endpoint of endpoints) {
      const enabled = JSON.parse(endpoint.enabled_events_json) as string[];
      if (!enabled.includes("*") && !enabled.includes(eventType)) continue;

      this.db
        .prepare(
          `INSERT INTO webhook_deliveries
            (id, endpoint_id, event_type, payload_json, status, attempts, next_attempt_at, created_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(newId("wd"), endpoint.id, eventType, JSON.stringify(payload), createdAt, createdAt);
    }
  }

  /** Process pending webhook deliveries with exponential backoff. */
  processPending(limit = 10): number {
    const now = new Date().toISOString();
    const pending = this.db
      .prepare(
        `SELECT d.*, e.url, e.secret FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id = d.endpoint_id
         WHERE d.status = 'pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
         ORDER BY d.created_at ASC LIMIT ?`,
      )
      .all(now, limit) as (WebhookDeliveryRow & { url: string; secret: string })[];

    let processed = 0;
    for (const delivery of pending) {
      this.attemptDelivery(delivery);
      processed++;
    }
    return processed;
  }

  private attemptDelivery(
    delivery: WebhookDeliveryRow & { url: string; secret: string },
  ): void {
    const body = delivery.payload_json;
    const signature = createHmac("sha256", delivery.secret).update(body).digest("hex");
    const attempts = delivery.attempts + 1;

    // Simulated delivery: localhost and webhook.site succeed; others may fail randomly.
    const simulatedStatus = delivery.url.includes("fail") ? 500 : 200;
    const simulatedBody = simulatedStatus === 200 ? '{"received":true}' : '{"error":"simulated failure"}';
    const delivered = simulatedStatus >= 200 && simulatedStatus < 300;

    if (delivered) {
      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET status = 'delivered', attempts = ?, response_status = ?, response_body = ?,
               delivered_at = ?, next_attempt_at = NULL
           WHERE id = ?`,
        )
        .run(attempts, simulatedStatus, simulatedBody, new Date().toISOString(), delivery.id);
    } else if (attempts >= 5) {
      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET status = 'failed', attempts = ?, response_status = ?, response_body = ?
           WHERE id = ?`,
        )
        .run(attempts, simulatedStatus, simulatedBody, delivery.id);
    } else {
      const backoffMs = Math.min(60_000, 1000 * 2 ** attempts);
      const nextAttempt = new Date(Date.now() + backoffMs).toISOString();
      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET attempts = ?, response_status = ?, response_body = ?, next_attempt_at = ?
           WHERE id = ?`,
        )
        .run(attempts, simulatedStatus, simulatedBody, nextAttempt, delivery.id);
    }

    void signature;
  }
}

export function startWebhookWorker(
  outbox: OutboxService,
  webhooks: WebhookService,
  intervalMs = 3000,
): NodeJS.Timeout {
  return setInterval(() => {
    const events = outbox.claimBatch();
    for (const event of events) {
      webhooks.enqueueFromOutbox(event.merchantId, event.type, event.data);
      outbox.markProcessed(event.id);
    }
    webhooks.processPending();
  }, intervalMs);
}
