import type Database from "better-sqlite3";
import { z } from "zod";
import type { DisputeRow } from "./db.js";
import { AppError } from "./errors.js";
import { newId } from "./ids.js";
import type { OutboxService } from "./outbox.js";

const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const createDisputeSchema = z.object({
  paymentId: z.string().min(1),
  amount: z.number().int().positive().optional(),
  reason: z.enum([
    "fraudulent",
    "duplicate",
    "product_not_received",
    "unrecognized",
    "credit_not_processed",
    "general",
  ]),
});

export const resolveDisputeSchema = z.object({
  outcome: z.enum(["won", "lost"]),
});

export const listDisputesQuerySchema = z.object({
  status: z.preprocess(blankToUndefined, z.string().optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(25)),
  offset: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
});

export type CreateDisputeInput = z.infer<typeof createDisputeSchema>;
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;
export type ListDisputesQuery = z.infer<typeof listDisputesQuerySchema>;

export interface Dispute {
  id: string;
  paymentId: string;
  paymentAmount: number;
  customerName: string;
  amount: number;
  reason: string;
  status: string;
  evidenceDueBy: string;
  createdAt: string;
  resolvedAt: string | null;
}

function rowToDispute(
  row: DisputeRow & { payment_amount?: number; customer_name?: string },
): Dispute {
  return {
    id: row.id,
    paymentId: row.payment_id,
    paymentAmount: row.payment_amount ?? 0,
    customerName: row.customer_name ?? "",
    amount: row.amount,
    reason: row.reason,
    status: row.status,
    evidenceDueBy: row.evidence_due_by,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class DisputeService {
  constructor(
    private readonly db: Database.Database,
    private readonly outbox: OutboxService,
  ) {}

  create(merchantId: string, input: CreateDisputeInput): Dispute {
    const payment = this.db
      .prepare(`SELECT * FROM payments WHERE id = ? AND merchant_id = ?`)
      .get(input.paymentId, merchantId) as
      | { id: string; amount: number; amount_refunded: number; status: string; customer_name: string }
      | undefined;

    if (!payment) throw new AppError(404, "Payment not found", "payment_not_found");
    if (payment.status === "declined") {
      throw new AppError(409, "Cannot dispute a declined payment", "cannot_dispute_declined");
    }

    const existing = this.db
      .prepare(`SELECT id FROM disputes WHERE payment_id = ? AND status IN ('needs_response', 'under_review')`)
      .get(input.paymentId);
    if (existing) {
      throw new AppError(409, "An open dispute already exists for this payment", "dispute_exists");
    }

    const refundable = payment.amount - payment.amount_refunded;
    const amount = input.amount ?? refundable;
    if (amount > refundable) {
      throw new AppError(400, "Dispute amount exceeds refundable balance", "dispute_amount_too_large");
    }

    const id = newId("dp");
    const createdAt = new Date().toISOString();
    const evidenceDueBy = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO disputes (id, payment_id, amount, reason, status, evidence_due_by, created_at)
           VALUES (?, ?, ?, ?, 'needs_response', ?, ?)`,
        )
        .run(id, input.paymentId, amount, input.reason, evidenceDueBy, createdAt);

      this.db
        .prepare(
          `INSERT INTO payment_events (id, payment_id, type, message, created_at)
           VALUES (?, ?, 'dispute.opened', ?, ?)`,
        )
        .run(newId("evt"), input.paymentId, `Dispute opened (${input.reason}) for ${amount} cents`, createdAt);
    })();

    this.outbox.publish({
      type: "dispute.created",
      merchantId,
      data: { disputeId: id, paymentId: input.paymentId, amount, reason: input.reason },
    });

    return this.get(merchantId, id);
  }

  list(merchantId: string, query: ListDisputesQuery) {
    const filters = ["p.merchant_id = @merchantId"];
    const params: Record<string, unknown> = { merchantId };
    if (query.status) {
      filters.push("d.status = @status");
      params.status = query.status;
    }
    const where = `WHERE ${filters.join(" AND ")}`;
    const { total } = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM disputes d
         JOIN payments p ON p.id = d.payment_id ${where}`,
      )
      .get(params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT d.*, p.amount AS payment_amount, p.customer_name
         FROM disputes d
         JOIN payments p ON p.id = d.payment_id
         ${where}
         ORDER BY d.created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit, offset: query.offset }) as (DisputeRow & {
      payment_amount: number;
      customer_name: string;
    })[];

    return {
      disputes: rows.map(rowToDispute),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  get(merchantId: string, id: string): Dispute {
    const row = this.db
      .prepare(
        `SELECT d.*, p.amount AS payment_amount, p.customer_name, p.merchant_id
         FROM disputes d
         JOIN payments p ON p.id = d.payment_id
         WHERE d.id = ?`,
      )
      .get(id) as
      | (DisputeRow & { payment_amount: number; customer_name: string; merchant_id: string })
      | undefined;
    if (!row || row.merchant_id !== merchantId) {
      throw new AppError(404, `Dispute ${id} not found`, "dispute_not_found");
    }
    return rowToDispute(row);
  }

  resolve(merchantId: string, id: string, input: ResolveDisputeInput): Dispute {
    const dispute = this.get(merchantId, id);
    if (dispute.status === "won" || dispute.status === "lost") {
      throw new AppError(409, "Dispute already resolved", "dispute_resolved");
    }

    const resolvedAt = new Date().toISOString();
    const eventType = input.outcome === "won" ? "dispute.won" : "dispute.lost";

    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE disputes SET status = ?, resolved_at = ? WHERE id = ?`)
        .run(input.outcome, resolvedAt, id);

      this.db
        .prepare(
          `INSERT INTO payment_events (id, payment_id, type, message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          newId("evt"),
          dispute.paymentId,
          eventType,
          `Dispute ${input.outcome} by processor review`,
          resolvedAt,
        );

      if (input.outcome === "lost") {
        this.db
          .prepare(
            `UPDATE merchants SET balance = balance - (
               SELECT amount FROM disputes WHERE id = ?
             ) WHERE id = ?`,
          )
          .run(id, merchantId);
      }
    })();

    this.outbox.publish({
      type: `dispute.${input.outcome}`,
      merchantId,
      data: { disputeId: id, paymentId: dispute.paymentId },
    });

    return this.get(merchantId, id);
  }

  submitEvidence(merchantId: string, id: string): Dispute {
    const dispute = this.get(merchantId, id);
    if (dispute.status !== "needs_response") {
      throw new AppError(409, "Evidence can only be submitted for disputes needing response", "invalid_dispute_state");
    }
    this.db.prepare(`UPDATE disputes SET status = 'under_review' WHERE id = ?`).run(id);
    return this.get(merchantId, id);
  }
}
