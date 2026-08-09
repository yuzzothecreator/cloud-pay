import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import type {
  PaymentEventRow,
  PaymentEventType,
  PaymentRow,
  PaymentStatus,
  RefundRow,
} from "./db.js";

const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 20);

export const PAYMENT_STATUSES = [
  "succeeded",
  "declined",
  "partially_refunded",
  "refunded",
] as const satisfies readonly PaymentStatus[];

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
  cardNumber: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ""))
    .refine((v) => /^\d{12,19}$/.test(v), "cardNumber must be 12-19 digits"),
});

export const refundPaymentSchema = z.object({
  amount: z
    .number({ invalid_type_error: "amount must be a number" })
    .int("amount must be an integer number of cents")
    .positive("amount must be greater than zero")
    .optional(),
  reason: z.string().trim().max(280).default(""),
});

/** Query-string values arrive as strings; blanks mean "filter not applied". */
const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const listPaymentsQuerySchema = z.object({
  status: z.preprocess(blankToUndefined, z.enum(PAYMENT_STATUSES).optional()),
  q: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(25)),
  offset: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  description: string;
  customerName: string;
  customerEmail: string;
  cardLast4: string;
  cardBrand: string;
  status: PaymentStatus;
  failureReason: string | null;
  amountRefunded: number;
  amountRefundable: number;
  createdAt: string;
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
  partiallyRefundedCount: number;
  refundedCount: number;
  declinedCount: number;
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

export class PaymentError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

/** Luhn checksum validation for card numbers. */
export function isLuhnValid(cardNumber: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = cardNumber.length - 1; i >= 0; i--) {
    let digit = Number(cardNumber[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Rough card-brand detection from the leading digits. */
export function detectBrand(cardNumber: string): string {
  if (/^4/.test(cardNumber)) return "visa";
  if (/^5[1-5]/.test(cardNumber) || /^2[2-7]/.test(cardNumber)) return "mastercard";
  if (/^3[47]/.test(cardNumber)) return "amex";
  if (/^6(?:011|5)/.test(cardNumber)) return "discover";
  return "unknown";
}

export function formatAmount(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

/**
 * Simulated processor decisions keyed on well-known test card numbers so the
 * demo behaves deterministically without contacting a real payment network.
 */
const DECLINE_CARDS: Record<string, string> = {
  "4000000000000002": "card_declined",
  "4000000000009995": "insufficient_funds",
  "4000000000000069": "expired_card",
};

function rowToPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    cardLast4: row.card_last4,
    cardBrand: row.card_brand,
    status: row.status,
    failureReason: row.failure_reason,
    amountRefunded: row.amount_refunded,
    amountRefundable: row.status === "declined" ? 0 : row.amount - row.amount_refunded,
    createdAt: row.created_at,
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
    input.cardNumber,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export class PaymentService {
  constructor(private readonly db: Database.Database) {}

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
    const status: PaymentStatus = declineReason ? "declined" : "succeeded";
    const createdAt = new Date().toISOString();

    const row: PaymentRow = {
      id: `pay_${newId()}`,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      customer_name: input.customerName,
      customer_email: input.customerEmail,
      card_last4: last4,
      card_brand: brand,
      status,
      failure_reason: declineReason,
      amount_refunded: 0,
      created_at: createdAt,
    };

    const persist = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO payments
            (id, amount, currency, description, customer_name, customer_email,
             card_last4, card_brand, status, failure_reason, amount_refunded, created_at)
           VALUES
            (@id, @amount, @currency, @description, @customer_name, @customer_email,
             @card_last4, @card_brand, @status, @failure_reason, @amount_refunded, @created_at)`,
        )
        .run(row);

      this.record(
        row.id,
        "payment.created",
        `Payment request received for ${formatAmount(row.amount, row.currency)} on ${brand} ···· ${last4}`,
      );
      if (declineReason) {
        this.record(row.id, "payment.declined", `Declined by processor (${declineReason})`);
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

    return { payment: rowToPayment(row), replayed: false };
  }

  list(query: ListPaymentsQuery): PaymentPage {
    const filters: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.status) {
      filters.push(`status = @status`);
      params.status = query.status;
    }
    if (query.q) {
      filters.push(
        `(customer_name LIKE @q OR customer_email LIKE @q OR description LIKE @q OR id LIKE @q)`,
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

      this.db
        .prepare(
          `INSERT INTO refunds (id, payment_id, amount, reason, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(`re_${newId()}`, id, amount, input.reason, new Date().toISOString());

      this.db
        .prepare(`UPDATE payments SET amount_refunded = ?, status = ? WHERE id = ?`)
        .run(amountRefunded, status, id);

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

    return apply();
  }

  stats(): PaymentStats {
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS count,
           COALESCE(SUM(status = 'succeeded'), 0) AS succeededCount,
           COALESCE(SUM(status = 'partially_refunded'), 0) AS partiallyRefundedCount,
           COALESCE(SUM(status = 'refunded'), 0) AS refundedCount,
           COALESCE(SUM(status = 'declined'), 0) AS declinedCount,
           COALESCE(SUM(CASE WHEN status != 'declined' THEN amount ELSE 0 END), 0) AS grossVolume,
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
    this.db
      .prepare(
        `INSERT INTO payment_events (id, payment_id, type, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(`evt_${newId()}`, paymentId, type, message, new Date().toISOString());
  }
}
