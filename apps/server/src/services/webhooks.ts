import { createHmac, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WebhookDeliveryRow, WebhookEndpointRow } from "../db.js";
import { PaymentError } from "../lib/errors.js";
import { prefixedId } from "../lib/ids.js";
import type { EventBus } from "./events.js";

export type WebhookTransport = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; body: string }>;

const ALL_EVENTS = ["*"] as const;

export const createWebhookEndpointSchema = z.object({
  url: z.string().trim().url(),
  description: z.string().trim().max(280).default(""),
  events: z.array(z.string().min(1).max(80)).min(1).default([...ALL_EVENTS]),
});

export const updateWebhookEndpointSchema = z.object({
  url: z.string().trim().url().optional(),
  description: z.string().trim().max(280).optional(),
  enabled: z.boolean().optional(),
  events: z.array(z.string().min(1).max(80)).min(1).optional(),
});

export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;
export type UpdateWebhookEndpointInput = z.infer<typeof updateWebhookEndpointSchema>;

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  description: string;
  enabled: boolean;
  events: string[];
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastError: string | null;
  responseStatus: number | null;
  createdAt: string;
  deliveredAt: string | null;
}

function parseEvents(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : ["*"];
  } catch {
    return ["*"];
  }
}

function rowToEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    secret: row.secret,
    description: row.description,
    enabled: row.enabled === 1,
    events: parseEvents(row.events),
    createdAt: row.created_at,
  };
}

function rowToDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload;
  }
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    responseStatus: row.response_status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

const defaultTransport: WebhookTransport = async (url, headers, body) => {
  const res = await fetch(url, { method: "POST", headers, body });
  const text = await res.text().catch(() => "");
  return { status: res.status, body: text };
};

export class WebhookService {
  private transport: WebhookTransport;
  private autoDeliver: boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly events: EventBus,
    options: { transport?: WebhookTransport; autoDeliver?: boolean } = {},
  ) {
    this.transport = options.transport ?? defaultTransport;
    this.autoDeliver = options.autoDeliver ?? true;
    this.events.on((event) => {
      this.enqueue(event.type, event.id, {
        id: event.id,
        type: event.type,
        object: event.objectType,
        objectId: event.objectId,
        data: event.payload,
        createdAt: event.createdAt,
      });
    });
  }

  setTransport(transport: WebhookTransport): void {
    this.transport = transport;
  }

  create(input: CreateWebhookEndpointInput): WebhookEndpoint {
    const row: WebhookEndpointRow = {
      id: prefixedId("we"),
      url: input.url,
      secret: `whsec_${randomBytes(24).toString("base64url")}`,
      description: input.description,
      enabled: 1,
      events: JSON.stringify(input.events),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO webhook_endpoints (id, url, secret, description, enabled, events, created_at)
         VALUES (@id, @url, @secret, @description, @enabled, @events, @created_at)`,
      )
      .run(row);
    return rowToEndpoint(row);
  }

  list(): WebhookEndpoint[] {
    const rows = this.db
      .prepare(`SELECT * FROM webhook_endpoints ORDER BY created_at DESC, rowid DESC`)
      .all() as WebhookEndpointRow[];
    return rows.map(rowToEndpoint);
  }

  get(id: string): WebhookEndpoint {
    return rowToEndpoint(this.row(id));
  }

  update(id: string, input: UpdateWebhookEndpointInput): WebhookEndpoint {
    const current = this.row(id);
    const next = {
      url: input.url ?? current.url,
      description: input.description ?? current.description,
      enabled: input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
      events: input.events ? JSON.stringify(input.events) : current.events,
    };
    this.db
      .prepare(
        `UPDATE webhook_endpoints SET url = ?, description = ?, enabled = ?, events = ? WHERE id = ?`,
      )
      .run(next.url, next.description, next.enabled, next.events, id);
    return this.get(id);
  }

  remove(id: string): void {
    const result = this.db.prepare(`DELETE FROM webhook_endpoints WHERE id = ?`).run(id);
    if (result.changes === 0) {
      throw new PaymentError(404, `Webhook endpoint ${id} not found`, "webhook_not_found");
    }
  }

  listDeliveries(endpointId?: string, limit = 50): WebhookDelivery[] {
    const rows = endpointId
      ? (this.db
          .prepare(
            `SELECT * FROM webhook_deliveries WHERE endpoint_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(endpointId, limit) as WebhookDeliveryRow[])
      : (this.db
          .prepare(
            `SELECT * FROM webhook_deliveries ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(limit) as WebhookDeliveryRow[]);
    return rows.map(rowToDelivery);
  }

  enqueue(eventType: string, eventId: string, payload: unknown): WebhookDelivery[] {
    const endpoints = this.db
      .prepare(`SELECT * FROM webhook_endpoints WHERE enabled = 1`)
      .all() as WebhookEndpointRow[];

    const deliveries: WebhookDelivery[] = [];
    for (const endpoint of endpoints) {
      const events = parseEvents(endpoint.events);
      if (!events.includes("*") && !events.includes(eventType)) continue;

      const createdAt = new Date().toISOString();
      const row: WebhookDeliveryRow = {
        id: prefixedId("wd"),
        endpoint_id: endpoint.id,
        event_id: eventId,
        event_type: eventType,
        payload: JSON.stringify(payload),
        status: "pending",
        attempts: 0,
        last_error: null,
        response_status: null,
        created_at: createdAt,
        delivered_at: null,
      };
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries
            (id, endpoint_id, event_id, event_type, payload, status, attempts, last_error, response_status, created_at, delivered_at)
           VALUES
            (@id, @endpoint_id, @event_id, @event_type, @payload, @status, @attempts, @last_error, @response_status, @created_at, @delivered_at)`,
        )
        .run(row);
      const delivery = rowToDelivery(row);
      deliveries.push(delivery);
      if (this.autoDeliver) {
        void this.deliver(delivery.id);
      }
    }
    return deliveries;
  }

  async deliver(deliveryId: string): Promise<WebhookDelivery> {
    const row = this.db.prepare(`SELECT * FROM webhook_deliveries WHERE id = ?`).get(deliveryId) as
      | WebhookDeliveryRow
      | undefined;
    if (!row) {
      throw new PaymentError(404, `Webhook delivery ${deliveryId} not found`, "delivery_not_found");
    }

    const endpoint = this.row(row.endpoint_id);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signWebhookPayload(endpoint.secret, timestamp, row.payload);
    const headers = {
      "Content-Type": "application/json",
      "X-Cloud-Pay-Event": row.event_type,
      "X-Cloud-Pay-Delivery": row.id,
      "X-Cloud-Pay-Timestamp": timestamp,
      "X-Cloud-Pay-Signature": `t=${timestamp},v1=${signature}`,
      "User-Agent": "cloud-pay-webhooks/1.0",
    };

    let status: WebhookDeliveryRow["status"] = "failed";
    let responseStatus: number | null = null;
    let lastError: string | null = null;
    let deliveredAt: string | null = null;

    try {
      const result = await this.transport(endpoint.url, headers, row.payload);
      responseStatus = result.status;
      if (result.status >= 200 && result.status < 300) {
        status = "delivered";
        deliveredAt = new Date().toISOString();
      } else {
        lastError = `HTTP ${result.status}: ${result.body.slice(0, 200)}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = ?, attempts = attempts + 1, last_error = ?, response_status = ?, delivered_at = ?
         WHERE id = ?`,
      )
      .run(status, lastError, responseStatus, deliveredAt, deliveryId);

    return this.listDeliveries(undefined, 1000).find((d) => d.id === deliveryId)!;
  }

  async retry(deliveryId: string): Promise<WebhookDelivery> {
    return this.deliver(deliveryId);
  }

  private row(id: string): WebhookEndpointRow {
    const row = this.db.prepare(`SELECT * FROM webhook_endpoints WHERE id = ?`).get(id) as
      | WebhookEndpointRow
      | undefined;
    if (!row) {
      throw new PaymentError(404, `Webhook endpoint ${id} not found`, "webhook_not_found");
    }
    return row;
  }
}
