import type Database from "better-sqlite3";
import { z } from "zod";

const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const analyticsQuerySchema = z.object({
  days: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(90).default(14)),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export interface DailyBucket {
  date: string;
  volume: number;
  refunded: number;
  net: number;
  count: number;
  declined: number;
}

export interface AnalyticsSnapshot {
  days: number;
  currency: string;
  series: DailyBucket[];
  totals: {
    volume: number;
    refunded: number;
    net: number;
    count: number;
    declined: number;
    customers: number;
    openDisputes: number;
    webhookFailures: number;
  };
  topCustomers: Array<{
    id: string;
    name: string;
    email: string;
    lifetimeValue: number;
    paymentCount: number;
  }>;
  statusBreakdown: Array<{ status: string; count: number }>;
}

export class AnalyticsService {
  constructor(private readonly db: Database.Database) {}

  snapshot(query: AnalyticsQuery): AnalyticsSnapshot {
    const days = query.days;
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const startIso = start.toISOString();

    const payments = this.db
      .prepare(
        `SELECT amount, amount_refunded, status, created_at, currency
         FROM payments WHERE created_at >= ?`,
      )
      .all(startIso) as Array<{
      amount: number;
      amount_refunded: number;
      status: string;
      created_at: string;
      currency: string;
    }>;

    const buckets = new Map<string, DailyBucket>();
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, { date: key, volume: 0, refunded: 0, net: 0, count: 0, declined: 0 });
    }

    let currency = "usd";
    for (const payment of payments) {
      currency = payment.currency || currency;
      const key = payment.created_at.slice(0, 10);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.count += 1;
      if (payment.status === "declined" || payment.status === "canceled") {
        if (payment.status === "declined") bucket.declined += 1;
        continue;
      }
      bucket.volume += payment.amount;
      bucket.refunded += payment.amount_refunded;
      bucket.net += payment.amount - payment.amount_refunded;
    }

    const series = [...buckets.values()];
    const totals = series.reduce(
      (acc, b) => ({
        volume: acc.volume + b.volume,
        refunded: acc.refunded + b.refunded,
        net: acc.net + b.net,
        count: acc.count + b.count,
        declined: acc.declined + b.declined,
      }),
      { volume: 0, refunded: 0, net: 0, count: 0, declined: 0 },
    );

    const { customers } = this.db
      .prepare(`SELECT COUNT(*) AS customers FROM customers`)
      .get() as { customers: number };

    const { openDisputes } = this.db
      .prepare(
        `SELECT COUNT(*) AS openDisputes FROM disputes WHERE status IN ('needs_response', 'under_review')`,
      )
      .get() as { openDisputes: number };

    const { webhookFailures } = this.db
      .prepare(`SELECT COUNT(*) AS webhookFailures FROM webhook_deliveries WHERE status = 'failed'`)
      .get() as { webhookFailures: number };

    const topCustomers = this.db
      .prepare(
        `SELECT c.id, c.name, c.email,
           COALESCE(SUM(CASE WHEN p.status NOT IN ('declined', 'canceled')
             THEN p.amount - p.amount_refunded ELSE 0 END), 0) AS lifetime_value,
           COUNT(p.id) AS payment_count
         FROM customers c
         LEFT JOIN payments p ON p.customer_id = c.id
         GROUP BY c.id
         ORDER BY lifetime_value DESC
         LIMIT 5`,
      )
      .all() as Array<{
      id: string;
      name: string;
      email: string;
      lifetime_value: number;
      payment_count: number;
    }>;

    const statusBreakdown = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM payments GROUP BY status ORDER BY count DESC`)
      .all() as Array<{ status: string; count: number }>;

    return {
      days,
      currency,
      series,
      totals: {
        ...totals,
        customers,
        openDisputes,
        webhookFailures,
      },
      topCustomers: topCustomers.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        lifetimeValue: c.lifetime_value,
        paymentCount: c.payment_count,
      })),
      statusBreakdown,
    };
  }
}
