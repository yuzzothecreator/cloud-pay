import type Database from "better-sqlite3";
import { z } from "zod";
import type { PriceRow, SubscriptionInvoiceRow, SubscriptionRow } from "./db.js";
import { AppError } from "./errors.js";
import { newId } from "./ids.js";
import type { OutboxService } from "./outbox.js";
import type { PaymentService } from "./payments.js";

const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const createSubscriptionSchema = z.object({
  customerId: z.string().min(1),
  priceId: z.string().min(1),
  cardNumber: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ""))
    .refine((v) => /^\d{12,19}$/.test(v), "cardNumber must be 12-19 digits"),
  trialDays: z.number().int().min(0).max(30).default(0),
});

export const listSubscriptionsQuerySchema = z.object({
  status: z.preprocess(blankToUndefined, z.string().optional()),
  customerId: z.preprocess(blankToUndefined, z.string().optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(25)),
  offset: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
});

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type ListSubscriptionsQuery = z.infer<typeof listSubscriptionsQuerySchema>;

export interface SubscriptionInvoice {
  id: string;
  subscriptionId: string;
  paymentId: string | null;
  amount: number;
  currency: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  priceId: string;
  productName: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  latestPaymentId: string | null;
  invoices: SubscriptionInvoice[];
  createdAt: string;
}

function addInterval(date: Date, interval: string, count: number): Date {
  const next = new Date(date);
  switch (interval) {
    case "day":
      next.setUTCDate(next.getUTCDate() + count);
      break;
    case "week":
      next.setUTCDate(next.getUTCDate() + count * 7);
      break;
    case "month":
      next.setUTCMonth(next.getUTCMonth() + count);
      break;
    case "year":
      next.setUTCFullYear(next.getUTCFullYear() + count);
      break;
    default:
      next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
}

function rowToInvoice(row: SubscriptionInvoiceRow): SubscriptionInvoice {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    paymentId: row.payment_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    createdAt: row.created_at,
  };
}

export class SubscriptionService {
  constructor(
    private readonly db: Database.Database,
    private readonly payments: PaymentService,
    private readonly outbox: OutboxService,
  ) {}

  create(merchantId: string, input: CreateSubscriptionInput): Subscription {
    const customer = this.db
      .prepare(`SELECT * FROM customers WHERE id = ? AND merchant_id = ?`)
      .get(input.customerId, merchantId) as
      | { id: string; name: string; email: string }
      | undefined;
    if (!customer) throw new AppError(404, "Customer not found", "customer_not_found");

    const price = this.db
      .prepare(
        `SELECT pr.*, p.merchant_id, p.name AS product_name
         FROM prices pr
         JOIN products p ON p.id = pr.product_id
         WHERE pr.id = ? AND p.merchant_id = ? AND pr.active = 1`,
      )
      .get(input.priceId, merchantId) as
      | (PriceRow & { merchant_id: string; product_name: string })
      | undefined;
    if (!price) throw new AppError(404, "Price not found", "price_not_found");
    if (!price.interval) {
      throw new AppError(400, "Subscriptions require a recurring price", "price_not_recurring");
    }

    const now = new Date();
    const trialEnd =
      input.trialDays > 0 ? addInterval(now, "day", input.trialDays) : now;
    const periodEnd = addInterval(trialEnd, price.interval, price.interval_count ?? 1);
    const status = input.trialDays > 0 ? "trialing" : "active";
    const subId = newId("sub");
    const createdAt = now.toISOString();

    let latestPaymentId: string | null = null;

    const persist = this.db.transaction(() => {
      if (input.trialDays === 0) {
        const payment = this.payments.create(
          {
            amount: price.unit_amount,
            currency: price.currency,
            description: `Subscription to ${price.product_name}`,
            customerName: customer.name,
            customerEmail: customer.email,
            cardNumber: input.cardNumber,
            customerId: customer.id,
          },
          merchantId,
        );
        latestPaymentId = payment.payment.id;
        if (payment.payment.status === "declined") {
          throw new AppError(402, "Initial subscription payment declined", "subscription_payment_declined");
        }
      }

      this.db
        .prepare(
          `INSERT INTO subscriptions
            (id, merchant_id, customer_id, price_id, status, current_period_start,
             current_period_end, cancel_at_period_end, latest_payment_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          subId,
          merchantId,
          customer.id,
          price.id,
          status,
          trialEnd.toISOString(),
          periodEnd.toISOString(),
          latestPaymentId,
          createdAt,
        );

      this.db
        .prepare(
          `INSERT INTO subscription_invoices
            (id, subscription_id, payment_id, amount, currency, status, period_start, period_end, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId("in"),
          subId,
          latestPaymentId,
          price.unit_amount,
          price.currency,
          latestPaymentId ? "paid" : "open",
          trialEnd.toISOString(),
          periodEnd.toISOString(),
          createdAt,
        );
    });

    persist();

    this.outbox.publish({
      type: "subscription.created",
      merchantId,
      data: { subscriptionId: subId, customerId: customer.id, priceId: price.id },
    });

    return this.get(merchantId, subId);
  }

  list(merchantId: string, query: ListSubscriptionsQuery) {
    const filters = ["s.merchant_id = @merchantId"];
    const params: Record<string, unknown> = { merchantId };
    if (query.status) {
      filters.push("s.status = @status");
      params.status = query.status;
    }
    if (query.customerId) {
      filters.push("s.customer_id = @customerId");
      params.customerId = query.customerId;
    }
    const where = `WHERE ${filters.join(" AND ")}`;
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM subscriptions s ${where}`)
      .get(params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT s.id FROM subscriptions s ${where}
         ORDER BY s.created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit, offset: query.offset }) as { id: string }[];

    return {
      subscriptions: rows.map((r) => this.get(merchantId, r.id)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  get(merchantId: string, id: string): Subscription {
    const row = this.db
      .prepare(
        `SELECT s.*, c.name AS customer_name, c.email AS customer_email,
                pr.unit_amount, pr.currency, pr.interval, p.name AS product_name
         FROM subscriptions s
         JOIN customers c ON c.id = s.customer_id
         JOIN prices pr ON pr.id = s.price_id
         JOIN products p ON p.id = pr.product_id
         WHERE s.id = ? AND s.merchant_id = ?`,
      )
      .get(id, merchantId) as
      | (SubscriptionRow & {
          customer_name: string;
          customer_email: string;
          unit_amount: number;
          currency: string;
          interval: string | null;
          product_name: string;
        })
      | undefined;
    if (!row) throw new AppError(404, `Subscription ${id} not found`, "subscription_not_found");

    const invoices = this.db
      .prepare(`SELECT * FROM subscription_invoices WHERE subscription_id = ? ORDER BY created_at ASC`)
      .all(id) as SubscriptionInvoiceRow[];

    return {
      id: row.id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      priceId: row.price_id,
      productName: row.product_name,
      unitAmount: row.unit_amount,
      currency: row.currency,
      interval: row.interval,
      status: row.status,
      currentPeriodStart: row.current_period_start,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: row.cancel_at_period_end === 1,
      latestPaymentId: row.latest_payment_id,
      invoices: invoices.map(rowToInvoice),
      createdAt: row.created_at,
    };
  }

  cancel(merchantId: string, id: string, atPeriodEnd = true): Subscription {
    const sub = this.get(merchantId, id);
    if (sub.status === "canceled") {
      throw new AppError(409, "Subscription already canceled", "subscription_canceled");
    }
    if (atPeriodEnd) {
      this.db
        .prepare(`UPDATE subscriptions SET cancel_at_period_end = 1 WHERE id = ?`)
        .run(id);
    } else {
      this.db
        .prepare(`UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = 0 WHERE id = ?`)
        .run(id);
    }
    this.outbox.publish({
      type: "subscription.canceled",
      merchantId,
      data: { subscriptionId: id, atPeriodEnd },
    });
    return this.get(merchantId, id);
  }

  /** Renew due subscriptions — called by background worker. */
  renewDue(): number {
    const now = new Date().toISOString();
    const due = this.db
      .prepare(
        `SELECT s.*, c.name AS customer_name, c.email AS customer_email,
                pr.unit_amount, pr.currency, pr.interval, pr.interval_count, p.name AS product_name
         FROM subscriptions s
         JOIN customers c ON c.id = s.customer_id
         JOIN prices pr ON pr.id = s.price_id
         JOIN products p ON p.id = pr.product_id
         WHERE s.status IN ('active', 'past_due')
           AND s.current_period_end <= ?
           AND s.cancel_at_period_end = 0`,
      )
      .all(now) as (SubscriptionRow & {
      customer_name: string;
      customer_email: string;
      unit_amount: number;
      currency: string;
      interval: string;
      interval_count: number;
      product_name: string;
    })[];

    let renewed = 0;
    for (const sub of due) {
      try {
        this.renewOne(sub);
        renewed++;
      } catch (err) {
        console.error(`Failed to renew subscription ${sub.id}:`, err);
        this.db
          .prepare(`UPDATE subscriptions SET status = 'past_due' WHERE id = ?`)
          .run(sub.id);
      }
    }
    return renewed;
  }

  private renewOne(sub: SubscriptionRow & {
    customer_name: string;
    customer_email: string;
    unit_amount: number;
    currency: string;
    interval: string;
    interval_count: number;
    product_name: string;
  }): void {
    const periodStart = new Date(sub.current_period_end);
    const periodEnd = addInterval(periodStart, sub.interval, sub.interval_count ?? 1);

    const payment = this.payments.create(
      {
        amount: sub.unit_amount,
        currency: sub.currency,
        description: `Renewal: ${sub.product_name}`,
        customerName: sub.customer_name,
        customerEmail: sub.customer_email,
        cardNumber: "4242424242424242",
        customerId: sub.customer_id,
      },
      sub.merchant_id,
    );

    const status = payment.payment.status === "declined" ? "past_due" : "active";

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE subscriptions
           SET status = ?, current_period_start = ?, current_period_end = ?, latest_payment_id = ?
           WHERE id = ?`,
        )
        .run(
          status,
          periodStart.toISOString(),
          periodEnd.toISOString(),
          payment.payment.id,
          sub.id,
        );

      this.db
        .prepare(
          `INSERT INTO subscription_invoices
            (id, subscription_id, payment_id, amount, currency, status, period_start, period_end, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId("in"),
          sub.id,
          payment.payment.id,
          sub.unit_amount,
          sub.currency,
          payment.payment.status === "declined" ? "open" : "paid",
          periodStart.toISOString(),
          periodEnd.toISOString(),
          new Date().toISOString(),
        );
    })();

    this.outbox.publish({
      type: "subscription.renewed",
      merchantId: sub.merchant_id,
      data: { subscriptionId: sub.id, paymentId: payment.payment.id, status },
    });
  }
}
