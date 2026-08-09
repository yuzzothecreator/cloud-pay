import type Database from "better-sqlite3";
import { AnalyticsService } from "./analytics.js";
import { AuthService } from "./auth.js";
import { CustomerService } from "./customers.js";
import { DisputeService } from "./disputes.js";
import { OutboxService } from "./outbox.js";
import { PaymentService } from "./payments.js";
import { PayoutService } from "./payouts.js";
import { ProductService } from "./products.js";
import { SubscriptionService } from "./subscriptions.js";
import { WebhookService } from "./webhooks.js";

export interface AppServices {
  auth: AuthService;
  payments: PaymentService;
  customers: CustomerService;
  products: ProductService;
  subscriptions: SubscriptionService;
  webhooks: WebhookService;
  disputes: DisputeService;
  payouts: PayoutService;
  analytics: AnalyticsService;
  outbox: OutboxService;
}

export function createServices(
  db: Database.Database,
  defaultMerchantId: string,
  requireAuth: boolean,
): AppServices {
  const outbox = new OutboxService(db);
  const payouts = new PayoutService(db, outbox);
  const payments = new PaymentService(db, outbox, payouts);
  const webhooks = new WebhookService(db, outbox);
  const subscriptions = new SubscriptionService(db, payments, outbox);

  return {
    auth: new AuthService(db, defaultMerchantId, requireAuth),
    payments,
    customers: new CustomerService(db),
    products: new ProductService(db),
    subscriptions,
    webhooks,
    disputes: new DisputeService(db, outbox),
    payouts,
    analytics: new AnalyticsService(db),
    outbox,
  };
}

export function startBackgroundWorkers(services: AppServices): NodeJS.Timeout[] {
  const timers: NodeJS.Timeout[] = [];

  timers.push(
    setInterval(() => {
      const events = services.outbox.claimBatch();
      for (const event of events) {
        services.webhooks.enqueueFromOutbox(event.merchantId, event.type, event.data);
        services.outbox.markProcessed(event.id);
      }
      services.webhooks.processPending();
    }, 3000),
  );

  timers.push(
    setInterval(() => {
      services.subscriptions.renewDue();
      services.payouts.settlePending();
    }, 60_000),
  );

  return timers;
}
