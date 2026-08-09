import type Database from "better-sqlite3";
import { z } from "zod";

const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const analyticsQuerySchema = z.object({
  days: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(90).default(30)),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export interface DailyVolume {
  date: string;
  gross: number;
  net: number;
  refunds: number;
  count: number;
}

export interface StatusBreakdown {
  status: string;
  count: number;
  volume: number;
}

export interface BrandBreakdown {
  brand: string;
  count: number;
  volume: number;
}

export interface AnalyticsReport {
  dailyVolume: DailyVolume[];
  statusBreakdown: StatusBreakdown[];
  brandBreakdown: BrandBreakdown[];
  topCustomers: { customerId: string | null; name: string; email: string; volume: number; count: number }[];
  subscriptionMetrics: {
    active: number;
    trialing: number;
    pastDue: number;
    canceled: number;
    mrr: number;
  };
  disputeMetrics: {
    open: number;
    won: number;
    lost: number;
    totalAmount: number;
  };
}

export class AnalyticsService {
  constructor(private readonly db: Database.Database) {}

  report(merchantId: string, query: AnalyticsQuery): AnalyticsReport {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - query.days);
    const sinceIso = since.toISOString();

    const dailyVolume = this.db
      .prepare(
        `SELECT
           substr(created_at, 1, 10) AS date,
           COALESCE(SUM(CASE WHEN status != 'declined' THEN amount ELSE 0 END), 0) AS gross,
           COALESCE(SUM(CASE WHEN status != 'declined' THEN amount - amount_refunded ELSE 0 END), 0) AS net,
           COALESCE(SUM(amount_refunded), 0) AS refunds,
           COUNT(*) AS count
         FROM payments
         WHERE merchant_id = ? AND created_at >= ?
         GROUP BY substr(created_at, 1, 10)
         ORDER BY date ASC`,
      )
      .all(merchantId, sinceIso) as DailyVolume[];

    const statusBreakdown = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count,
                COALESCE(SUM(amount), 0) AS volume
         FROM payments WHERE merchant_id = ? AND created_at >= ?
         GROUP BY status`,
      )
      .all(merchantId, sinceIso) as StatusBreakdown[];

    const brandBreakdown = this.db
      .prepare(
        `SELECT card_brand AS brand, COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN status != 'declined' THEN amount ELSE 0 END), 0) AS volume
         FROM payments WHERE merchant_id = ? AND created_at >= ?
         GROUP BY card_brand ORDER BY volume DESC`,
      )
      .all(merchantId, sinceIso) as BrandBreakdown[];

    const topCustomers = this.db
      .prepare(
        `SELECT customer_id AS customerId, customer_name AS name, customer_email AS email,
                COALESCE(SUM(CASE WHEN status != 'declined' THEN amount - amount_refunded ELSE 0 END), 0) AS volume,
                COUNT(*) AS count
         FROM payments
         WHERE merchant_id = ? AND created_at >= ?
         GROUP BY customer_id, customer_name, customer_email
         ORDER BY volume DESC LIMIT 10`,
      )
      .all(merchantId, sinceIso) as AnalyticsReport["topCustomers"];

    const subCounts = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(status = 'active'), 0) AS active,
           COALESCE(SUM(status = 'trialing'), 0) AS trialing,
           COALESCE(SUM(status = 'past_due'), 0) AS pastDue,
           COALESCE(SUM(status = 'canceled'), 0) AS canceled
         FROM subscriptions WHERE merchant_id = ?`,
      )
      .get(merchantId) as Omit<AnalyticsReport["subscriptionMetrics"], "mrr">;

    const mrrRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(
           CASE pr.interval
             WHEN 'month' THEN pr.unit_amount / COALESCE(pr.interval_count, 1)
             WHEN 'year' THEN pr.unit_amount / (12 * COALESCE(pr.interval_count, 1))
             WHEN 'week' THEN pr.unit_amount * 52 / (12 * COALESCE(pr.interval_count, 1))
             WHEN 'day' THEN pr.unit_amount * 365 / (12 * COALESCE(pr.interval_count, 1))
             ELSE pr.unit_amount
           END
         ), 0) AS mrr
         FROM subscriptions s
         JOIN prices pr ON pr.id = s.price_id
         WHERE s.merchant_id = ? AND s.status IN ('active', 'trialing')`,
      )
      .get(merchantId) as { mrr: number };

    const disputeMetrics = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(d.status IN ('needs_response', 'under_review')), 0) AS open,
           COALESCE(SUM(d.status = 'won'), 0) AS won,
           COALESCE(SUM(d.status = 'lost'), 0) AS lost,
           COALESCE(SUM(d.amount), 0) AS totalAmount
         FROM disputes d
         JOIN payments p ON p.id = d.payment_id
         WHERE p.merchant_id = ?`,
      )
      .get(merchantId) as AnalyticsReport["disputeMetrics"];

    return {
      dailyVolume,
      statusBreakdown,
      brandBreakdown,
      topCustomers,
      subscriptionMetrics: { ...subCounts, mrr: Math.round(mrrRow.mrr) },
      disputeMetrics,
    };
  }
}
