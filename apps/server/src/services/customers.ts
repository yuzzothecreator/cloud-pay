import type Database from "better-sqlite3";
import { z } from "zod";
import type { CustomerRow } from "../db.js";
import { PaymentError } from "../lib/errors.js";
import { prefixedId } from "../lib/ids.js";
import { parseMetadata, serializeMetadata } from "../lib/money.js";
import type { EventBus } from "./events.js";

const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const upsertCustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  phone: z.string().trim().max(40).default(""),
  metadata: z.record(z.string().max(200)).default({}),
});

export const listCustomersQuerySchema = z.object({
  q: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(25)),
  offset: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
});

export type UpsertCustomerInput = z.infer<typeof upsertCustomerSchema>;
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  metadata: Record<string, string>;
  paymentCount: number;
  lifetimeValue: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerPage {
  customers: Customer[];
  total: number;
  limit: number;
  offset: number;
}

function rowToCustomer(
  row: CustomerRow,
  stats: { paymentCount: number; lifetimeValue: number } = { paymentCount: 0, lifetimeValue: 0 },
): Customer {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    metadata: parseMetadata(row.metadata),
    paymentCount: stats.paymentCount,
    lifetimeValue: stats.lifetimeValue,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CustomerService {
  constructor(
    private readonly db: Database.Database,
    private readonly events: EventBus,
  ) {}

  /** Find-or-create by email, used when charging a card. */
  ensure(input: UpsertCustomerInput): Customer {
    const existing = this.db
      .prepare(`SELECT * FROM customers WHERE email = ?`)
      .get(input.email.toLowerCase()) as CustomerRow | undefined;

    if (existing) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE customers SET name = ?, phone = COALESCE(NULLIF(?, ''), phone),
           metadata = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.name,
          input.phone,
          serializeMetadata({ ...parseMetadata(existing.metadata), ...input.metadata }),
          now,
          existing.id,
        );
      const updated = this.get(existing.id);
      this.events.emitPlatform("customer.updated", "customer", updated.id, updated);
      return updated;
    }

    const now = new Date().toISOString();
    const row: CustomerRow = {
      id: prefixedId("cus"),
      name: input.name,
      email: input.email.toLowerCase(),
      phone: input.phone,
      metadata: serializeMetadata(input.metadata),
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO customers (id, name, email, phone, metadata, created_at, updated_at)
         VALUES (@id, @name, @email, @phone, @metadata, @created_at, @updated_at)`,
      )
      .run(row);

    const customer = rowToCustomer(row);
    this.events.emitPlatform("customer.created", "customer", customer.id, customer);
    return customer;
  }

  upsert(input: UpsertCustomerInput): Customer {
    return this.ensure(input);
  }

  list(query: ListCustomersQuery): CustomerPage {
    const filters: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.q) {
      filters.push(`(name LIKE @q OR email LIKE @q OR phone LIKE @q OR id LIKE @q)`);
      params.q = `%${query.q}%`;
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM customers ${where}`)
      .get(params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT c.*,
           COALESCE((SELECT COUNT(*) FROM payments p WHERE p.customer_id = c.id), 0) AS payment_count,
           COALESCE((SELECT SUM(CASE WHEN p.status != 'declined' AND p.status != 'canceled'
             THEN p.amount - p.amount_refunded ELSE 0 END) FROM payments p WHERE p.customer_id = c.id), 0) AS lifetime_value
         FROM customers c
         ${where}
         ORDER BY c.created_at DESC, c.rowid DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit, offset: query.offset }) as Array<
      CustomerRow & { payment_count: number; lifetime_value: number }
    >;

    return {
      customers: rows.map((row) =>
        rowToCustomer(row, {
          paymentCount: row.payment_count,
          lifetimeValue: row.lifetime_value,
        }),
      ),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  get(id: string): Customer {
    const row = this.db
      .prepare(
        `SELECT c.*,
           COALESCE((SELECT COUNT(*) FROM payments p WHERE p.customer_id = c.id), 0) AS payment_count,
           COALESCE((SELECT SUM(CASE WHEN p.status != 'declined' AND p.status != 'canceled'
             THEN p.amount - p.amount_refunded ELSE 0 END) FROM payments p WHERE p.customer_id = c.id), 0) AS lifetime_value
         FROM customers c WHERE c.id = ?`,
      )
      .get(id) as (CustomerRow & { payment_count: number; lifetime_value: number }) | undefined;

    if (!row) {
      throw new PaymentError(404, `Customer ${id} not found`, "customer_not_found");
    }

    return rowToCustomer(row, {
      paymentCount: row.payment_count,
      lifetimeValue: row.lifetime_value,
    });
  }
}
