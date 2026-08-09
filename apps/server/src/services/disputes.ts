import type Database from "better-sqlite3";
import { z } from "zod";
import type { DisputeReason, DisputeRow, DisputeStatus, PaymentRow } from "../db.js";
import { PaymentError } from "../lib/errors.js";
import { prefixedId } from "../lib/ids.js";
import { formatAmount } from "../lib/money.js";
import type { EventBus } from "./events.js";

const DISPUTE_REASONS = [
  "fraudulent",
  "product_not_received",
  "product_unacceptable",
  "duplicate",
  "subscription_canceled",
  "unrecognized",
  "general",
] as const satisfies readonly DisputeReason[];

const DISPUTE_STATUSES = [
  "needs_response",
  "under_review",
  "won",
  "lost",
  "withdrawn",
] as const satisfies readonly DisputeStatus[];

const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const createDisputeSchema = z.object({
  amount: z
    .number({ invalid_type_error: "amount must be a number" })
    .int()
    .positive()
    .optional(),
  reason: z.enum(DISPUTE_REASONS).default("general"),
  evidence: z.string().trim().max(2000).default(""),
});

export const updateDisputeSchema = z.object({
  status: z.enum(DISPUTE_STATUSES).optional(),
  evidence: z.string().trim().max(2000).optional(),
});

export const listDisputesQuerySchema = z.object({
  status: z.preprocess(blankToUndefined, z.enum(DISPUTE_STATUSES).optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(25)),
  offset: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
});

export type CreateDisputeInput = z.infer<typeof createDisputeSchema>;
export type UpdateDisputeInput = z.infer<typeof updateDisputeSchema>;
export type ListDisputesQuery = z.infer<typeof listDisputesQuerySchema>;

export interface Dispute {
  id: string;
  paymentId: string;
  amount: number;
  currency: string;
  reason: DisputeReason;
  status: DisputeStatus;
  evidence: string;
  createdAt: string;
  updatedAt: string;
}

export interface DisputePage {
  disputes: Dispute[];
  total: number;
  limit: number;
  offset: number;
}

function rowToDispute(row: DisputeRow): Dispute {
  return {
    id: row.id,
    paymentId: row.payment_id,
    amount: row.amount,
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    evidence: row.evidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DisputeService {
  constructor(
    private readonly db: Database.Database,
    private readonly events: EventBus,
  ) {}

  create(paymentId: string, input: CreateDisputeInput): Dispute {
    const payment = this.db.prepare(`SELECT * FROM payments WHERE id = ?`).get(paymentId) as
      | PaymentRow
      | undefined;
    if (!payment) {
      throw new PaymentError(404, `Payment ${paymentId} not found`, "payment_not_found");
    }

    const openable = ["succeeded", "partially_refunded", "requires_capture"];
    if (!openable.includes(payment.status)) {
      throw new PaymentError(
        409,
        `Cannot open a dispute on a ${payment.status} payment`,
        "cannot_dispute_payment",
      );
    }

    const open = this.db
      .prepare(
        `SELECT id FROM disputes WHERE payment_id = ? AND status IN ('needs_response', 'under_review')`,
      )
      .get(paymentId);
    if (open) {
      throw new PaymentError(
        409,
        "Payment already has an open dispute",
        "dispute_already_open",
      );
    }

    const amount = input.amount ?? payment.amount - payment.amount_refunded;
    if (amount <= 0 || amount > payment.amount - payment.amount_refunded) {
      throw new PaymentError(400, "Dispute amount is invalid", "invalid_dispute_amount");
    }

    const now = new Date().toISOString();
    const row: DisputeRow = {
      id: prefixedId("dp"),
      payment_id: paymentId,
      amount,
      currency: payment.currency,
      reason: input.reason,
      status: "needs_response",
      evidence: input.evidence,
      created_at: now,
      updated_at: now,
    };

    const persist = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO disputes (id, payment_id, amount, currency, reason, status, evidence, created_at, updated_at)
           VALUES (@id, @payment_id, @amount, @currency, @reason, @status, @evidence, @created_at, @updated_at)`,
        )
        .run(row);

      this.events.recordPaymentEvent(
        paymentId,
        "dispute.created",
        `Dispute opened for ${formatAmount(amount, payment.currency)} (${input.reason})`,
      );
    });
    persist();

    const dispute = rowToDispute(row);
    this.events.emitPlatform("dispute.created", "dispute", dispute.id, dispute);
    return dispute;
  }

  list(query: ListDisputesQuery): DisputePage {
    const filters: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.status) {
      filters.push(`status = @status`);
      params.status = query.status;
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM disputes ${where}`)
      .get(params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM disputes ${where}
         ORDER BY created_at DESC, rowid DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit, offset: query.offset }) as DisputeRow[];

    return {
      disputes: rows.map(rowToDispute),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  get(id: string): Dispute {
    const row = this.db.prepare(`SELECT * FROM disputes WHERE id = ?`).get(id) as
      | DisputeRow
      | undefined;
    if (!row) {
      throw new PaymentError(404, `Dispute ${id} not found`, "dispute_not_found");
    }
    return rowToDispute(row);
  }

  update(id: string, input: UpdateDisputeInput): Dispute {
    const current = this.get(id);
    if (["won", "lost", "withdrawn"].includes(current.status) && input.status) {
      throw new PaymentError(409, "Closed disputes cannot change status", "dispute_closed");
    }

    const status = input.status ?? current.status;
    const evidence = input.evidence ?? current.evidence;
    const updatedAt = new Date().toISOString();

    const apply = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE disputes SET status = ?, evidence = ?, updated_at = ? WHERE id = ?`)
        .run(status, evidence, updatedAt, id);

      this.events.recordPaymentEvent(
        current.paymentId,
        "dispute.updated",
        `Dispute ${id} is now ${status}`,
      );
    });
    apply();

    const dispute = this.get(id);
    this.events.emitPlatform("dispute.updated", "dispute", dispute.id, dispute);
    return dispute;
  }
}
