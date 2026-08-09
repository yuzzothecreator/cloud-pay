import type Database from "better-sqlite3";
import { z } from "zod";
import type { PriceRow, ProductRow } from "./db.js";
import { AppError } from "./errors.js";
import { newId } from "./ids.js";

const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  active: z.boolean().default(true),
  metadata: z.record(z.string()).default({}),
});

export const createPriceSchema = z.object({
  unitAmount: z.number().int().positive(),
  currency: z.string().trim().toLowerCase().regex(/^[a-z]{3}$/),
  interval: z.enum(["day", "week", "month", "year"]).optional(),
  intervalCount: z.number().int().min(1).max(365).optional(),
  active: z.boolean().default(true),
});

export const listProductsQuerySchema = z.object({
  active: z.preprocess(blankToUndefined, z.enum(["true", "false"]).optional()),
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(25)),
  offset: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type CreatePriceInput = z.infer<typeof createPriceSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export interface Price {
  id: string;
  productId: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
  intervalCount: number | null;
  active: boolean;
  createdAt: string;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  active: boolean;
  metadata: Record<string, string>;
  prices: Price[];
  createdAt: string;
}

function rowToPrice(row: PriceRow): Price {
  return {
    id: row.id,
    productId: row.product_id,
    unitAmount: row.unit_amount,
    currency: row.currency,
    interval: row.interval,
    intervalCount: row.interval_count,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

function rowToProduct(row: ProductRow, prices: PriceRow[]): Product {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    active: row.active === 1,
    metadata: JSON.parse(row.metadata_json) as Record<string, string>,
    prices: prices.map(rowToPrice),
    createdAt: row.created_at,
  };
}

export class ProductService {
  constructor(private readonly db: Database.Database) {}

  create(merchantId: string, input: CreateProductInput): Product {
    const id = newId("prod");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO products (id, merchant_id, name, description, active, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        merchantId,
        input.name,
        input.description,
        input.active ? 1 : 0,
        JSON.stringify(input.metadata),
        createdAt,
      );
    return this.get(merchantId, id);
  }

  addPrice(merchantId: string, productId: string, input: CreatePriceInput): Price {
    this.assertProduct(merchantId, productId);
    if (input.interval && !input.intervalCount) {
      throw new AppError(400, "intervalCount is required for recurring prices", "invalid_price");
    }
    const id = newId("price");
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO prices (id, product_id, unit_amount, currency, interval, interval_count, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        productId,
        input.unitAmount,
        input.currency,
        input.interval ?? null,
        input.intervalCount ?? null,
        input.active ? 1 : 0,
        createdAt,
      );
    return rowToPrice(
      this.db.prepare(`SELECT * FROM prices WHERE id = ?`).get(id) as PriceRow,
    );
  }

  list(merchantId: string, query: ListProductsQuery) {
    const filters = ["merchant_id = @merchantId"];
    const params: Record<string, unknown> = { merchantId };
    if (query.active === "true") {
      filters.push("active = 1");
    } else if (query.active === "false") {
      filters.push("active = 0");
    }
    const where = `WHERE ${filters.join(" AND ")}`;
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM products ${where}`)
      .get(params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM products ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit, offset: query.offset }) as ProductRow[];

    return {
      products: rows.map((row) => {
        const prices = this.db
          .prepare(`SELECT * FROM prices WHERE product_id = ? ORDER BY created_at ASC`)
          .all(row.id) as PriceRow[];
        return rowToProduct(row, prices);
      }),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  get(merchantId: string, id: string): Product {
    const row = this.db
      .prepare(`SELECT * FROM products WHERE id = ? AND merchant_id = ?`)
      .get(id, merchantId) as ProductRow | undefined;
    if (!row) throw new AppError(404, `Product ${id} not found`, "product_not_found");
    const prices = this.db
      .prepare(`SELECT * FROM prices WHERE product_id = ? ORDER BY created_at ASC`)
      .all(id) as PriceRow[];
    return rowToProduct(row, prices);
  }

  private assertProduct(merchantId: string, productId: string): void {
    const row = this.db
      .prepare(`SELECT id FROM products WHERE id = ? AND merchant_id = ?`)
      .get(productId, merchantId);
    if (!row) throw new AppError(404, `Product ${productId} not found`, "product_not_found");
  }
}
