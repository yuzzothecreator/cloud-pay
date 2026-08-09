import type Database from "better-sqlite3";
import { z } from "zod";
import type { CustomerRow } from "./db.js";
import { AppError } from "./errors.js";
import { newId } from "./ids.js";

const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  phone: z.string().trim().max(40).default(""),
  metadata: z.record(z.string()).default({}),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export const listCustomersQuerySchema = z.object({
  q: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(25)),
  offset: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  metadata: Record<string, string>;
  paymentCount: number;
  totalSpent: number;
  createdAt: string;
}

function rowToCustomer(row: CustomerRow, stats?: { paymentCount: number; totalSpent: number }): Customer {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    metadata: JSON.parse(row.metadata_json) as Record<string, string>,
    paymentCount: stats?.paymentCount ?? 0,
    totalSpent: stats?.totalSpent ?? 0,
    createdAt: row.created_at,
  };
}

export class CustomerService {
  constructor(private readonly db: Database.Database) {}

  create(merchantId: string, input: CreateCustomerInput): Customer {
    const id = newId("cus");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO customers (id, merchant_id, name, email, phone, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, merchantId, input.name, input.email, input.phone, JSON.stringify(input.metadata), createdAt);
    return rowToCustomer({
      id,
      merchant_id: merchantId,
      name: input.name,
      email: input.email,
      phone: input.phone,
      metadata_json: JSON.stringify(input.metadata),
      created_at: createdAt,
    });
  }

  list(merchantId: string, query: ListCustomersQuery) {
    const filters = ["c.merchant_id = @merchantId"];
    const params: Record<string, unknown> = { merchantId };
    if (query.q) {
      filters.push(`(name LIKE @q OR email LIKE @q OR phone LIKE @q OR id LIKE @q)`);
      params.q = `%${query.q}%`;
    }
    const where = `WHERE ${filters.join(" AND ")}`;
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM customers c ${where}`)
      .get(params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT c.*,
                COALESCE(SUM(CASE WHEN p.status != 'declined' THEN 1 ELSE 0 END), 0) AS payment_count,
                COALESCE(SUM(CASE WHEN p.status != 'declined' THEN p.amount - p.amount_refunded ELSE 0 END), 0) AS total_spent
         FROM customers c
         LEFT JOIN payments p ON p.customer_id = c.id
         ${where}
         GROUP BY c.id
         ORDER BY c.created_at DESC, c.rowid DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit, offset: query.offset }) as (CustomerRow & {
      payment_count: number;
      total_spent: number;
    })[];

    return {
      customers: rows.map((r) =>
        rowToCustomer(r, { paymentCount: r.payment_count, totalSpent: r.total_spent }),
      ),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  get(merchantId: string, id: string): Customer {
    const row = this.db
      .prepare(`SELECT * FROM customers WHERE id = ? AND merchant_id = ?`)
      .get(id, merchantId) as CustomerRow | undefined;
    if (!row) throw new AppError(404, `Customer ${id} not found`, "customer_not_found");

    const stats = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status != 'declined' THEN 1 ELSE 0 END), 0) AS payment_count,
           COALESCE(SUM(CASE WHEN status != 'declined' THEN amount - amount_refunded ELSE 0 END), 0) AS total_spent
         FROM payments WHERE customer_id = ?`,
      )
      .get(id) as { payment_count: number; total_spent: number };

    return rowToCustomer(row, { paymentCount: stats.payment_count, totalSpent: stats.total_spent });
  }

  update(merchantId: string, id: string, input: UpdateCustomerInput): Customer {
    const existing = this.get(merchantId, id);
    const next = {
      name: input.name ?? existing.name,
      email: input.email ?? existing.email,
      phone: input.phone ?? existing.phone,
      metadata: input.metadata ?? existing.metadata,
    };
    this.db
      .prepare(
        `UPDATE customers SET name = ?, email = ?, phone = ?, metadata_json = ? WHERE id = ?`,
      )
      .run(next.name, next.email, next.phone, JSON.stringify(next.metadata), id);
    return this.get(merchantId, id);
  }

  delete(merchantId: string, id: string): void {
    const result = this.db
      .prepare(`DELETE FROM customers WHERE id = ? AND merchant_id = ?`)
      .run(id, merchantId);
    if (result.changes === 0) {
      throw new AppError(404, `Customer ${id} not found`, "customer_not_found");
    }
  }
}
