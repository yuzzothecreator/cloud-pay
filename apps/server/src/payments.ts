import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  CaptureMethod,
  PaymentEventRow,
  PaymentEventType,
  PaymentRow,
  PaymentStatus,
  RefundRow,
} from "./db.js";
import { DECLINE_CARDS, detectBrand, isLuhnValid } from "./lib/card.js";
import { PaymentError } from "./lib/errors.js";
import { prefixedId } from "./lib/ids.js";
import { formatAmount, parseMetadata, serializeMetadata } from "./lib/money.js";
import type { CustomerService } from "./services/customers.js";
import type { EventBus } from "./services/events.js";

export { isLuhnValid, detectBrand } from "./lib/card.js";
export { PaymentError } from "./lib/errors.js";
export { formatAmount } from "./lib/money.js";

export const PAYMENT_STATUSES = [
  "requires_capture",
  "succeeded",
  "declined",
  "partially_refunded",
  "refunded",
  "canceled",
] as const satisfies readonly PaymentStatus[];

const metadataSchema = z
  .record(z.string().max(200))
  .refine((obj) => Object.keys(obj).length <= 20, "metadata may have at most 20 keys")
  .default({});

export const createPaymentSchema = z.object({
  amount: z
    .number({ invalid_type_error: "amount must be a number" })
    .int("amount must be an integer number of cents")
    .positive("amount must be greater than zero"),
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .default("usd")
    .refine((v) => /^[a-z]{3}$/.test(v), "currency must be a 3-letter ISO code"),
  description: z.string().trim().max(280).default(""),
  customerName: z.string().trim().min(1, "customerName is required").max(120),
  customerEmail: z.string().trim().email("customerEmail must be a valid email"),
  customerPhone: z.string().trim().max(40).default(""),
  cardNumber: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ""))
    .refine((v) => /^\d{12,19}$/.test(v), "cardNumber must be 12-19 digits"),
  captureMethod: z.enum(["automatic", "manual"]).default("automatic"),
  metadata: metadataSchema,
  statementDescriptor: z
    .string()
    .trim()
    .max(22)
    .regex(/^[A-Za-z0-9 .*-]*$/, "statementDescriptor has invalid characters")
    .default(""),
});

export const refundPaymentSchema = z.object({
  amount: z
    .number({ invalid_type_error: "amount must be a number" })
    .int("amount must be an integer number of cents")
    .positive("amount must be greater than zero")
    .optional(),
  reason: z.string().trim().max(280).default(""),
});

export const capturePaymentSchema = z.object({
  amount: z
    .number({ invalid_type_error: "amount must be a number" })
    .int("amount must be an integer number of cents")
    .positive("amount must be greater than zero")
    .optional(),
});

/** Query-string values arrive as strings; blanks mean "filter not applied". */
const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const listPaymentsQuerySchema = z.object({
  status: z.preprocess(blankToUndefined, z.enum(PAYMENT_STATUSES).optional()),
  q: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
  customerId: z.preprocess(blankToUndefined, z.string().trim().max(40).optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(25)),
  offset: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;
export type CapturePaymentInput = z.infer<typeof capturePaymentSchema>;
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  description: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string;
  cardLast4: string;
  cardBrand: string;
  status: PaymentStatus;
  failureReason: string | null;
  amountRefunded: number;
  amountRefundable: number;
  amountCapturable: number;
  captureMethod: CaptureMethod;
  metadata: Record<string, string>;
  statementDescriptor: string;
  createdAt: string;
  updatedAt: string;
}

export interface Refund {
  id: string;
  paymentId: string;
  amount: number;
  reason: string;
  createdAt: string;
}

export interface PaymentEvent {
  id: string;
  type: PaymentEventType;
  message: string;
  createdAt: string;
}

/** A payment with its sub-resources expanded, for the detail view. */
export interface PaymentDetail extends Payment {
  refunds: Refund[];
  events: PaymentEvent[];
}

export interface PaymentPage {
  payments: Payment[];
  total: number;
  limit: number;
  offset: number;
}

export interface PaymentStats {
  count: number;
  succeededCount: number;
  requiresCaptureCount: number;
  partiallyRefundedCount: number;
  refundedCount: number;
  declinedCount: number;
  canceledCount: number;
  grossVolume: number;
  refundedVolume: number;
  netVolume: number;
  currency: string;
}

export interface CreatePaymentResult {
  payment: Payment;
  /** True when an Idempotency-Key replayed a previously stored payment. */
  replayed: boolean;
}

export interface IdempotencyContext {
  key: string;
}

function rowToPayment(row: PaymentRow): Payment {
  const refundableStatuses: PaymentStatus[] = ["succeeded", "partially_refunded"];
  const capturable = row.status === "requires_capture" ? row.amount_capturable : 0;
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    cardLast4: row.card_last4,
    cardBrand: row.card_brand,
    status: row.status,
    failureReason: row.failure_reason,
    amountRefunded: row.amount_refunded,
    amountRefundable: refundableStatuses.includes(row.status)
      ? row.amount - row.amount_refunded
      : 0,
    amountCapturable: capturable,
    captureMethod: row.capture_method,
    metadata: parseMetadata(row.metadata),
    statementDescriptor: row.statement_descriptor,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function rowToRefund(row: RefundRow): Refund {
  return {
    id: row.id,
    paymentId: row.payment_id,
    amount: row.amount,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function rowToEvent(row: PaymentEventRow): PaymentEvent {
  return {
    id: row.id,
    type: row.type,
    message: row.message,
    createdAt: row.created_at,
  };
}

/**
 * Hashes the normalised request so a replayed Idempotency-Key can be checked
 * against the parameters it was first used with.
 */
function hashCreateInput(input: CreatePaymentInput): string {
  const canonical = JSON.stringify([
    input.amount,
    input.currency,
    input.description,
    input.customerName,
    input.customerEmail,
    input.customerPhone,
    input.cardNumber,
    input.captureMethod,
    input.metadata,
    input.statementDescriptor,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export class PaymentService {
  constructor(
    private readonly db: Database.Database,
    private readonly events?: EventBus,
    private readonly customers?: CustomerService,
  ) {}

  create(input: CreatePaymentInput, idempotency?: IdempotencyContext): CreatePaymentResult {
    const requestHash = hashCreateInput(input);

    if (idempotency) {
      const existing = this.db
        .prepare(`SELECT * FROM idempotency_keys WHERE key = ?`)
        .get(idempotency.key) as { request_hash: string; payment_id: string } | undefined;

      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new PaymentError(
            409,
            "This Idempotency-Key was already used with different parameters",
            "idempotency_key_reuse",
          );
        }
        return { payment: this.get(existing.payment_id), replayed: true };
      }
    }

    const card = input.cardNumber;
    if (!isLuhnValid(card)) {
      throw new PaymentError(400, "Card number failed validation", "invalid_card_number");
    }

    const brand = detectBrand(card);
    const last4 = card.slice(-4);
    const declineReason = DECLINE_CARDS[card] ?? null;
    const createdAt = new Date().toISOString();

    let status: PaymentStatus;
    let amountCapturable = 0;
    if (declineReason) {
      status = "declined";
    } else if (input.captureMethod === "manual") {
      status = "requires_capture";
      amountCapturable = input.amount;
    } else {
      status = "succeeded";
    }

    const customer = this.customers?.ensure({
      name: input.customerName,
      email: input.customerEmail,
      phone: input.customerPhone,
      metadata: {},
    });

    const row: PaymentRow = {
      id: prefixedId("pay"),
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      customer_id: customer?.id ?? null,
      customer_name: input.customerName,
      customer_email: input.customerEmail,
      card_last4: last4,
      card_brand: brand,
      status,
      failure_reason: declineReason,
      amount_refunded: 0,
      amount_capturable: amountCapturable,
      capture_method: input.captureMethod,
      metadata: serializeMetadata(input.metadata),
      statement_descriptor: input.statementDescriptor,
      created_at: createdAt,
      updated_at: createdAt,
    };

    const persist = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO payments
            (id, amount, currency, description, customer_id, customer_name, customer_email,
             card_last4, card_brand, status, failure_reason, amount_refunded, amount_capturable,
             capture_method, metadata, statement_descriptor, created_at, updated_at)
           VALUES
            (@id, @amount, @currency, @description, @customer_id, @customer_name, @customer_email,
             @card_last4, @card_brand, @status, @failure_reason, @amount_refunded, @amount_capturable,
             @capture_method, @metadata, @statement_descriptor, @created_at, @updated_at)`,
        )
        .run(row);

      this.record(
        row.id,
        "payment.created",
        `Payment request received for ${formatAmount(row.amount, row.currency)} on ${brand} ···· ${last4}`,
      );

      if (declineReason) {
        this.record(row.id, "payment.declined", `Declined by processor (${declineReason})`);
      } else if (status === "requires_capture") {
        this.record(
          row.id,
          "payment.authorized",
          `Authorised ${formatAmount(row.amount, row.currency)} — awaiting capture`,
        );
      } else {
        this.record(row.id, "payment.succeeded", "Authorised and captured by processor");
      }

      if (idempotency) {
        this.db
          .prepare(
            `INSERT INTO idempotency_keys (key, request_hash, payment_id, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(idempotency.key, requestHash, row.id, createdAt);
      }
    });

    persist();

    const payment = rowToPayment(row);
    this.emit("payment.created", payment);
    if (payment.status === "succeeded") this.emit("payment.succeeded", payment);
    if (payment.status === "declined") this.emit("payment.declined", payment);
    if (payment.status === "requires_capture") this.emit("payment.authorized", payment);

    return { payment, replayed: false };
  }

  list(query: ListPaymentsQuery): PaymentPage {
    const filters: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.status) {
      filters.push(`status = @status`);
      params.status = query.status;
    }
    if (query.customerId) {
      filters.push(`customer_id = @customerId`);
      params.customerId = query.customerId;
    }
    if (query.q) {
      filters.push(
        `(customer_name LIKE @q OR customer_email LIKE @q OR description LIKE @q OR id LIKE @q OR statement_descriptor LIKE @q)`,
      );
      params.q = `%${query.q}%`;
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM payments ${where}`)
      .get(params) as { total: number };

    // rowid breaks ties between payments created within the same millisecond.
    const rows = this.db
      .prepare(
        `SELECT * FROM payments ${where}
         ORDER BY created_at DESC, rowid DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit, offset: query.offset }) as PaymentRow[];

    return {
      payments: rows.map(rowToPayment),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  get(id: string): Payment {
    return rowToPayment(this.row(id));
  }

  /** The payment plus its refunds and event timeline, for the detail view. */
  getDetail(id: string): PaymentDetail {
    const payment = rowToPayment(this.row(id));
    const refunds = this.db
      .prepare(`SELECT * FROM refunds WHERE payment_id = ? ORDER BY rowid ASC`)
      .all(id) as RefundRow[];
    const events = this.db
      .prepare(`SELECT * FROM payment_events WHERE payment_id = ? ORDER BY seq ASC`)
      .all(id) as PaymentEventRow[];

    return {
      ...payment,
      refunds: refunds.map(rowToRefund),
      events: events.map(rowToEvent),
    };
  }

  capture(id: string, input: CapturePaymentInput = {}): Payment {
    const apply = this.db.transaction(() => {
      const payment = rowToPayment(this.row(id));
      if (payment.status !== "requires_capture") {
        throw new PaymentError(
          409,
          "Only authorised payments can be captured",
          "cannot_capture_payment",
        );
      }

      const amount = input.amount ?? payment.amountCapturable;
      if (amount > payment.amountCapturable) {
        throw new PaymentError(
          400,
          `Capture of ${formatAmount(amount, payment.currency)} exceeds capturable amount`,
          "capture_amount_too_large",
        );
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE payments
           SET amount = ?, amount_capturable = 0, status = 'succeeded', updated_at = ?
           WHERE id = ?`,
        )
        .run(amount, now, id);

      this.record(
        id,
        "payment.captured",
        `Captured ${formatAmount(amount, payment.currency)}`,
      );
      this.record(id, "payment.succeeded", "Authorised funds captured");

      return rowToPayment(this.row(id));
    });

    const payment = apply();
    this.emit("payment.captured", payment);
    this.emit("payment.succeeded", payment);
    return payment;
  }

  cancel(id: string): Payment {
    const apply = this.db.transaction(() => {
      const payment = rowToPayment(this.row(id));
      if (payment.status !== "requires_capture") {
        throw new PaymentError(
          409,
          "Only authorised (uncaptured) payments can be canceled",
          "cannot_cancel_payment",
        );
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE payments SET status = 'canceled', amount_capturable = 0, updated_at = ? WHERE id = ?`,
        )
        .run(now, id);

      this.record(id, "payment.canceled", "Authorisation released — payment canceled");
      return rowToPayment(this.row(id));
    });

    const payment = apply();
    this.emit("payment.canceled", payment);
    return payment;
  }

  /**
   * Refunds all or part of a payment. Omitting `amount` refunds whatever
   * balance is left, so repeated partial refunds settle exactly at the total.
   */
  refund(id: string, input: RefundPaymentInput): Payment {
    const apply = this.db.transaction(() => {
      const payment = rowToPayment(this.row(id));

      if (payment.status === "declined") {
        throw new PaymentError(
          409,
          "Declined payments cannot be refunded",
          "cannot_refund_declined",
        );
      }
      if (payment.status === "canceled" || payment.status === "requires_capture") {
        throw new PaymentError(
          409,
          "Uncaptured payments cannot be refunded — cancel the authorisation instead",
          "cannot_refund_uncaptured",
        );
      }
      if (payment.amountRefundable <= 0) {
        throw new PaymentError(409, "Payment is already refunded", "already_refunded");
      }

      const amount = input.amount ?? payment.amountRefundable;
      if (amount > payment.amountRefundable) {
        throw new PaymentError(
          400,
          `Refund of ${formatAmount(amount, payment.currency)} exceeds the refundable balance of ${formatAmount(payment.amountRefundable, payment.currency)}`,
          "refund_amount_too_large",
        );
      }

      const amountRefunded = payment.amountRefunded + amount;
      const status: PaymentStatus =
        amountRefunded === payment.amount ? "refunded" : "partially_refunded";
      const now = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO refunds (id, payment_id, amount, reason, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(prefixedId("re"), id, amount, input.reason, now);

      this.db
        .prepare(
          `UPDATE payments SET amount_refunded = ?, status = ?, updated_at = ? WHERE id = ?`,
        )
        .run(amountRefunded, status, now, id);

      const reasonSuffix = input.reason ? ` — ${input.reason}` : "";
      this.record(
        id,
        "refund.created",
        `Refunded ${formatAmount(amount, payment.currency)} of ${formatAmount(payment.amount, payment.currency)}${reasonSuffix}`,
      );
      if (status === "refunded") {
        this.record(id, "payment.refunded", "Payment fully refunded");
      }

      return rowToPayment(this.row(id));
    });

    const payment = apply();
    this.emit("refund.created", payment);
    if (payment.status === "refunded") this.emit("payment.refunded", payment);
    return payment;
  }

  stats(): PaymentStats {
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS count,
           COALESCE(SUM(status = 'succeeded'), 0) AS succeededCount,
           COALESCE(SUM(status = 'requires_capture'), 0) AS requiresCaptureCount,
           COALESCE(SUM(status = 'partially_refunded'), 0) AS partiallyRefundedCount,
           COALESCE(SUM(status = 'refunded'), 0) AS refundedCount,
           COALESCE(SUM(status = 'declined'), 0) AS declinedCount,
           COALESCE(SUM(status = 'canceled'), 0) AS canceledCount,
           COALESCE(SUM(CASE WHEN status IN ('succeeded', 'partially_refunded', 'refunded')
             THEN amount ELSE 0 END), 0) AS grossVolume,
           COALESCE(SUM(amount_refunded), 0) AS refundedVolume
         FROM payments`,
      )
      .get() as Omit<PaymentStats, "netVolume" | "currency">;

    const latest = this.db
      .prepare(`SELECT currency FROM payments ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get() as { currency: string } | undefined;

    return {
      ...totals,
      netVolume: totals.grossVolume - totals.refundedVolume,
      currency: latest?.currency ?? "usd",
    };
  }

  /** CSV export of the current ledger for ops / finance. */
  exportCsv(): string {
    const rows = this.db
      .prepare(`SELECT * FROM payments ORDER BY created_at DESC, rowid DESC`)
      .all() as PaymentRow[];

    const header = [
      "id",
      "amount",
      "currency",
      "status",
      "customer_name",
      "customer_email",
      "customer_id",
      "description",
      "card_brand",
      "card_last4",
      "amount_refunded",
      "capture_method",
      "created_at",
    ];

    const escape = (value: string | number | null) => {
      const text = value == null ? "" : String(value);
      if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
      return text;
    };

    const lines = [header.join(",")];
    for (const row of rows) {
      lines.push(
        [
          row.id,
          row.amount,
          row.currency,
          row.status,
          row.customer_name,
          row.customer_email,
          row.customer_id,
          row.description,
          row.card_brand,
          row.card_last4,
          row.amount_refunded,
          row.capture_method,
          row.created_at,
        ]
          .map(escape)
          .join(","),
      );
    }
    return `${lines.join("\n")}\n`;
  }

  private row(id: string): PaymentRow {
    const row = this.db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id) as
      | PaymentRow
      | undefined;
    if (!row) {
      throw new PaymentError(404, `Payment ${id} not found`, "payment_not_found");
    }
    return row;
  }

  private record(paymentId: string, type: PaymentEventType, message: string): void {
    if (this.events) {
      this.events.recordPaymentEvent(paymentId, type, message);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO payment_events (id, payment_id, type, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(prefixedId("evt"), paymentId, type, message, new Date().toISOString());
  }

  private emit(type: string, payment: Payment): void {
    this.events?.emitPlatform(type, "payment", payment.id, payment);
  }
}
