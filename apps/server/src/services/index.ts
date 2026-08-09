import type Database from "better-sqlite3";
import { PaymentService } from "../payments.js";
import { AnalyticsService } from "./analytics.js";
import { ApiKeyService } from "./apiKeys.js";
import { CustomerService } from "./customers.js";
import { DisputeService } from "./disputes.js";
import { EventBus } from "./events.js";
import { WebhookService, type WebhookTransport } from "./webhooks.js";

export interface AppServices {
  db: Database.Database;
  events: EventBus;
  customers: CustomerService;
  payments: PaymentService;
  disputes: DisputeService;
  webhooks: WebhookService;
  apiKeys: ApiKeyService;
  analytics: AnalyticsService;
}

export function createServices(
  db: Database.Database,
  options: { transport?: WebhookTransport; autoDeliver?: boolean } = {},
): AppServices {
  const events = new EventBus(db);
  const customers = new CustomerService(db, events);
  const payments = new PaymentService(db, events, customers);
  const disputes = new DisputeService(db, events);
  const webhooks = new WebhookService(db, events, {
    transport: options.transport,
    autoDeliver: options.autoDeliver,
  });
  const apiKeys = new ApiKeyService(db);
  const analytics = new AnalyticsService(db);

  return { db, events, customers, payments, disputes, webhooks, apiKeys, analytics };
}
