import SQLite from "better-sqlite3";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { isLuhnValid } from "../src/payments.js";
import { createServices } from "../src/services.js";

const VISA = "4242424242424242";
const DECLINE = "4000000000000002";
const INVALID = "4242424242424241";

function createTestApp(db: Database.Database, merchantId: string) {
  const services = createServices(db, merchantId, false);
  return createApp(services, null);
}

describe("card helpers", () => {
  it("accepts a Luhn-valid number and rejects an invalid one", () => {
    expect(isLuhnValid(VISA)).toBe(true);
    expect(isLuhnValid(INVALID)).toBe(false);
  });
});

describe("payments API", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;
  let merchantId: string;

  beforeEach(() => {
    const ctx = openDatabase(":memory:");
    db = ctx.db;
    merchantId = ctx.defaultMerchantId;
    app = createTestApp(db, merchantId);
  });

  afterEach(() => {
    db.close();
  });

  const validBody = {
    amount: 2500,
    currency: "usd",
    description: "Pro plan",
    customerName: "Ada Lovelace",
    customerEmail: "ada@example.com",
    cardNumber: VISA,
  };

  const create = (overrides: Record<string, unknown> = {}) =>
    request(app)
      .post("/api/payments")
      .send({ ...validBody, ...overrides });

  it("creates a succeeded payment", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      amount: 2500,
      currency: "usd",
      status: "succeeded",
      cardLast4: "4242",
      cardBrand: "visa",
      amountRefunded: 0,
      amountRefundable: 2500,
    });
    expect(res.body.id).toMatch(/^pay_/);
  });

  it("declines a known test decline card", async () => {
    const res = await create({ cardNumber: DECLINE });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("declined");
    expect(res.body.failureReason).toBe("card_declined");
    expect(res.body.amountRefundable).toBe(0);
  });

  it("rejects an invalid card number with 400", async () => {
    const res = await create({ cardNumber: INVALID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_card_number");
  });

  it("rejects a malformed body with a validation error", async () => {
    const res = await request(app)
      .post("/api/payments")
      .send({ amount: -1, customerEmail: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it("lists payments newest first", async () => {
    await create({ description: "first" });
    await create({ description: "second" });
    const res = await request(app).get("/api/payments");
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
    expect(res.body.payments[0].description).toBe("second");
    expect(res.body).toMatchObject({ total: 2, limit: 25, offset: 0 });
  });

  it("returns 404 for an unknown payment", async () => {
    const res = await request(app).get("/api/payments/pay_missing");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("payment_not_found");
  });

  it("exposes a health endpoint", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("refunds", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const ctx = openDatabase(":memory:");
    db = ctx.db;
    app = createTestApp(db, ctx.defaultMerchantId);
  });

  afterEach(() => {
    db.close();
  });

  const validBody = {
    amount: 2500,
    currency: "usd",
    description: "Pro plan",
    customerName: "Ada Lovelace",
    customerEmail: "ada@example.com",
    cardNumber: VISA,
  };

  const createPayment = async (overrides: Record<string, unknown> = {}) => {
    const res = await request(app)
      .post("/api/payments")
      .send({ ...validBody, ...overrides });
    return res.body.id as string;
  };

  it("refunds a succeeded payment in full and blocks double refunds", async () => {
    const id = await createPayment();

    const refund = await request(app).post(`/api/payments/${id}/refund`);
    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({
      status: "refunded",
      amountRefunded: 2500,
      amountRefundable: 0,
    });

    const again = await request(app).post(`/api/payments/${id}/refund`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_refunded");
  });

  it("applies a partial refund and leaves the balance refundable", async () => {
    const id = await createPayment();

    const refund = await request(app)
      .post(`/api/payments/${id}/refund`)
      .send({ amount: 1000, reason: "goodwill" });

    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({
      status: "partially_refunded",
      amountRefunded: 1000,
      amountRefundable: 1500,
    });
  });

  it("settles at fully refunded after successive partial refunds", async () => {
    const id = await createPayment();

    await request(app).post(`/api/payments/${id}/refund`).send({ amount: 1000 });
    const second = await request(app).post(`/api/payments/${id}/refund`).send({ amount: 1200 });
    expect(second.body).toMatchObject({ status: "partially_refunded", amountRefunded: 2200 });

    const third = await request(app).post(`/api/payments/${id}/refund`);
    expect(third.body).toMatchObject({
      status: "refunded",
      amountRefunded: 2500,
      amountRefundable: 0,
    });

    const detail = await request(app).get(`/api/payments/${id}`);
    expect(detail.body.refunds.map((r: { amount: number }) => r.amount)).toEqual([1000, 1200, 300]);
  });

  it("rejects a refund larger than the refundable balance", async () => {
    const id = await createPayment();
    await request(app).post(`/api/payments/${id}/refund`).send({ amount: 2000 });

    const tooBig = await request(app).post(`/api/payments/${id}/refund`).send({ amount: 900 });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toBe("refund_amount_too_large");

    const detail = await request(app).get(`/api/payments/${id}`);
    expect(detail.body).toMatchObject({ amountRefunded: 2000, status: "partially_refunded" });
  });

  it("rejects a non-positive refund amount", async () => {
    const id = await createPayment();
    const res = await request(app).post(`/api/payments/${id}/refund`).send({ amount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("will not refund a declined payment", async () => {
    const id = await createPayment({ cardNumber: DECLINE });
    const refund = await request(app).post(`/api/payments/${id}/refund`);
    expect(refund.status).toBe(409);
    expect(refund.body.error).toBe("cannot_refund_declined");
  });

  it("returns 404 when refunding an unknown payment", async () => {
    const res = await request(app).post("/api/payments/pay_missing/refund");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("payment_not_found");
  });
});

describe("customers", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const ctx = openDatabase(":memory:");
    db = ctx.db;
    app = createTestApp(db, ctx.defaultMerchantId);
  });

  afterEach(() => {
    db.close();
  });

  it("creates and lists customers", async () => {
    const created = await request(app)
      .post("/api/customers")
      .send({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^cus_/);

    const list = await request(app).get("/api/customers");
    expect(list.body.total).toBe(1);
    expect(list.body.customers[0].name).toBe("Ada Lovelace");
  });
});

describe("products and subscriptions", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const ctx = openDatabase(":memory:");
    db = ctx.db;
    app = createTestApp(db, ctx.defaultMerchantId);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a product with a recurring price and subscription", async () => {
    const customer = await request(app)
      .post("/api/customers")
      .send({ name: "Ada", email: "ada@example.com" });

    const product = await request(app)
      .post("/api/products")
      .send({ name: "Pro Plan", description: "Monthly subscription" });
    expect(product.status).toBe(201);

    const price = await request(app)
      .post(`/api/products/${product.body.id}/prices`)
      .send({ unitAmount: 2900, currency: "usd", interval: "month", intervalCount: 1 });
    expect(price.status).toBe(201);

    const sub = await request(app)
      .post("/api/subscriptions")
      .send({
        customerId: customer.body.id,
        priceId: price.body.id,
        cardNumber: VISA,
      });
    expect(sub.status).toBe(201);
    expect(sub.body.status).toBe("active");
    expect(sub.body.invoices).toHaveLength(1);
  });
});

describe("disputes and payouts", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const ctx = openDatabase(":memory:");
    db = ctx.db;
    app = createTestApp(db, ctx.defaultMerchantId);
  });

  afterEach(() => {
    db.close();
  });

  it("opens a dispute on a payment", async () => {
    const payment = await request(app).post("/api/payments").send({
      amount: 5000,
      customerName: "Ada",
      customerEmail: "ada@example.com",
      cardNumber: VISA,
    });

    const dispute = await request(app).post("/api/disputes").send({
      paymentId: payment.body.id,
      reason: "fraudulent",
    });
    expect(dispute.status).toBe(201);
    expect(dispute.body.status).toBe("needs_response");
  });

  it("creates a payout when balance is available", async () => {
    await request(app).post("/api/payments").send({
      amount: 10000,
      customerName: "Ada",
      customerEmail: "ada@example.com",
      cardNumber: VISA,
    });

    const balance = await request(app).get("/api/balance");
    expect(balance.body.available).toBeGreaterThan(0);

    const payout = await request(app).post("/api/payouts").send({ amount: 1000 });
    expect(payout.status).toBe(201);
    expect(payout.body.status).toBe("pending");
  });
});

describe("schema migration", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cloud-pay-test-"));
    file = join(dir, "legacy.sqlite");

    const legacy = new SQLite(file);
    legacy.exec(`
      CREATE TABLE payments (
        id            TEXT PRIMARY KEY,
        amount        INTEGER NOT NULL,
        currency      TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        customer_name TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        card_last4    TEXT NOT NULL,
        card_brand    TEXT NOT NULL,
        status        TEXT NOT NULL,
        failure_reason TEXT,
        created_at    TEXT NOT NULL
      );
      INSERT INTO payments VALUES
        ('pay_old_refunded', 2500, 'usd', 'legacy', 'Ada', 'ada@example.com',
         '4242', 'visa', 'refunded', NULL, '2026-01-01T00:00:00.000Z'),
        ('pay_old_succeeded', 1000, 'usd', 'legacy', 'Ada', 'ada@example.com',
         '4242', 'visa', 'succeeded', NULL, '2026-01-02T00:00:00.000Z');
    `);
    legacy.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("backfills amount_refunded on a database created by an older version", () => {
    const ctx = openDatabase(file);
    const services = createServices(ctx.db, ctx.defaultMerchantId, false);

    expect(services.payments.get("pay_old_refunded", ctx.defaultMerchantId)).toMatchObject({
      amountRefunded: 2500,
      amountRefundable: 0,
    });
    expect(services.payments.get("pay_old_succeeded", ctx.defaultMerchantId)).toMatchObject({
      amountRefunded: 0,
      amountRefundable: 1000,
    });

    ctx.db.close();
  });
});
