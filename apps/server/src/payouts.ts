import type Database from "better-sqlite3";
import { z } from "zod";
import type { PayoutRow } from "./db.js";
import { AppError } from "./errors.js";
import { newId } from "./ids.js";
import type { OutboxService } from "./outbox.js";

const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const createPayoutSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().trim().toLowerCase().regex(/^[a-z]{3}$/).default("usd"),
});

export const listPayoutsQuerySchema = z.object({
  status: z.preprocess(blankToUndefined, z.string().optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(25)),
  offset: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
});

export type CreatePayoutInput = z.infer<typeof createPayoutSchema>;
export type ListPayoutsQuery = z.infer<typeof listPayoutsQuerySchema>;

export interface Payout {
  id: string;
  amount: number;
  currency: string;
  status: string;
  arrivalDate: string | null;
  createdAt: string;
}

export interface Balance {
  available: number;
  pending: number;
  currency: string;
  lifetimeVolume: number;
  lifetimeFees: number;
}

function rowToPayout(row: PayoutRow): Payout {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    arrivalDate: row.arrival_date,
    createdAt: row.created_at,
  };
}

export class PayoutService {
  constructor(
    private readonly db: Database.Database,
    private readonly outbox: OutboxService,
  ) {}

  balance(merchantId: string): Balance {
    const merchant = this.db
      .prepare(`SELECT balance, currency FROM merchants WHERE id = ?`)
      .get(merchantId) as { balance: number; currency: string };

    const volume = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status != 'declined' THEN amount - amount_refunded ELSE 0 END), 0) AS net
         FROM payments WHERE merchant_id = ?`,
      )
      .get(merchantId) as { net: number };

    const pendingPayouts = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS pending FROM payouts
         WHERE merchant_id = ? AND status IN ('pending', 'in_transit')`,
      )
      .get(merchantId) as { pending: number };

    const feeRate = 0.029;
    const lifetimeFees = Math.round(volume.net * feeRate);

    return {
      available: merchant.balance,
      pending: pendingPayouts.pending,
      currency: merchant.currency,
      lifetimeVolume: volume.net,
      lifetimeFees,
    };
  }

  create(merchantId: string, input: CreatePayoutInput): Payout {
    const bal = this.balance(merchantId);
    if (input.amount > bal.available) {
      throw new AppError(400, "Payout amount exceeds available balance", "insufficient_balance");
    }

    const id = newId("po");
    const createdAt = new Date().toISOString();
    const arrivalDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO payouts (id, merchant_id, amount, currency, status, arrival_date, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, merchantId, input.amount, input.currency, arrivalDate, createdAt);

      this.db
        .prepare(`UPDATE merchants SET balance = balance - ? WHERE id = ?`)
        .run(input.amount, merchantId);
    })();

    this.outbox.publish({
      type: "payout.created",
      merchantId,
      data: { payoutId: id, amount: input.amount },
    });

    return rowToPayout(
      this.db.prepare(`SELECT * FROM payouts WHERE id = ?`).get(id) as PayoutRow,
    );
  }

  list(merchantId: string, query: ListPayoutsQuery) {
    const filters = ["merchant_id = @merchantId"];
    const params: Record<string, unknown> = { merchantId };
    if (query.status) {
      filters.push("status = @status");
      params.status = query.status;
    }
    const where = `WHERE ${filters.join(" AND ")}`;
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM payouts ${where}`)
      .get(params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM payouts ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit, offset: query.offset }) as PayoutRow[];

    return {
      payouts: rows.map(rowToPayout),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /** Credit merchant balance from successful payments — called after payment creation. */
  creditFromPayment(merchantId: string, netAmount: number): void {
    const fee = Math.round(netAmount * 0.029) + 30;
    const credit = Math.max(0, netAmount - fee);
    this.db
      .prepare(`UPDATE merchants SET balance = balance + ? WHERE id = ?`)
      .run(credit, merchantId);
  }

  /** Advance pending payouts to paid — background worker. */
  settlePending(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE payouts SET status = 'paid'
         WHERE status = 'pending' AND arrival_date <= ?`,
      )
      .run(now);
    return result.changes;
  }
}
