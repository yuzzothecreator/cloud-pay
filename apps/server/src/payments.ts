import type Database from "better-sqlite3";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import type { PaymentRow, PaymentStatus } from "./db.js";

const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 20);

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

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

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
  createdAt: string;
}

export interface PaymentStats {
  count: number;
  succeededCount: number;
  refundedCount: number;
  declinedCount: number;
  grossVolume: number;
  netVolume: number;
  currency: string;
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
    createdAt: row.created_at,
  };
}

export class PaymentService {
  constructor(private readonly db: Database.Database) {}

  create(input: CreatePaymentInput): Payment {
    const card = input.cardNumber;
    if (!isLuhnValid(card)) {
      throw new PaymentError(400, "Card number failed validation", "invalid_card_number");
    }

    const brand = detectBrand(card);
    const last4 = card.slice(-4);
    const declineReason = DECLINE_CARDS[card] ?? null;
    const status: PaymentStatus = declineReason ? "declined" : "succeeded";

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
      created_at: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO payments
          (id, amount, currency, description, customer_name, customer_email,
           card_last4, card_brand, status, failure_reason, created_at)
         VALUES
          (@id, @amount, @currency, @description, @customer_name, @customer_email,
           @card_last4, @card_brand, @status, @failure_reason, @created_at)`,
      )
      .run(row);

    return rowToPayment(row);
  }

  list(): Payment[] {
    const rows = this.db
      .prepare(`SELECT * FROM payments ORDER BY created_at DESC, id DESC`)
      .all() as PaymentRow[];
    return rows.map(rowToPayment);
  }

  get(id: string): Payment {
    const row = this.db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id) as
      | PaymentRow
      | undefined;
    if (!row) {
      throw new PaymentError(404, `Payment ${id} not found`, "payment_not_found");
    }
    return rowToPayment(row);
  }

  refund(id: string): Payment {
    const payment = this.get(id);
    if (payment.status === "declined") {
      throw new PaymentError(
        409,
        "Declined payments cannot be refunded",
        "cannot_refund_declined",
      );
    }
    if (payment.status === "refunded") {
      throw new PaymentError(409, "Payment is already refunded", "already_refunded");
    }
    this.db.prepare(`UPDATE payments SET status = 'refunded' WHERE id = ?`).run(id);
    return this.get(id);
  }

  stats(): PaymentStats {
    const payments = this.list();
    const succeeded = payments.filter((p) => p.status === "succeeded");
    const refunded = payments.filter((p) => p.status === "refunded");
    const declined = payments.filter((p) => p.status === "declined");
    const grossVolume = [...succeeded, ...refunded].reduce((sum, p) => sum + p.amount, 0);
    const netVolume = succeeded.reduce((sum, p) => sum + p.amount, 0);
    return {
      count: payments.length,
      succeededCount: succeeded.length,
      refundedCount: refunded.length,
      declinedCount: declined.length,
      grossVolume,
      netVolume,
      currency: payments[0]?.currency ?? "usd",
    };
  }
}
