import SQLite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { isLuhnValid, PaymentService } from "../src/payments.js";
import { closeContext, createTestContext } from "./helpers.js";

const VISA = "4242424242424242";
const DECLINE = "4000000000000002";
const INVALID = "4242424242424241";

describe("card helpers", () => {
  it("accepts a Luhn-valid number and rejects an invalid one", () => {
    expect(isLuhnValid(VISA)).toBe(true);
    expect(isLuhnValid(INVALID)).toBe(false);
  });
});

describe("payments API", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    closeContext(ctx.db);
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
    request(ctx.app)
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
    const res = await request(ctx.app)
      .post("/api/payments")
      .send({ amount: -1, customerEmail: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it("lists payments newest first", async () => {
    await create({ description: "first" });
    await create({ description: "second" });
    const res = await request(ctx.app).get("/api/payments");
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
    expect(res.body.payments[0].description).toBe("second");
    expect(res.body).toMatchObject({ total: 2, limit: 25, offset: 0 });
  });

  it("returns 404 for an unknown payment", async () => {
    const res = await request(ctx.app).get("/api/payments/pay_missing");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("payment_not_found");
  });

  it("exposes a health endpoint", async () => {
    const res = await request(ctx.app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("refunds", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    closeContext(ctx.db);
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
    const res = await request(ctx.app)
      .post("/api/payments")
      .send({ ...validBody, ...overrides });
    return res.body.id as string;
  };

  it("refunds a succeeded payment in full and blocks double refunds", async () => {
    const id = await createPayment();

    const refund = await request(ctx.app).post(`/api/payments/${id}/refund`);
    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({
      status: "refunded",
      amountRefunded: 2500,
      amountRefundable: 0,
    });

    const again = await request(ctx.app).post(`/api/payments/${id}/refund`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_refunded");
  });

  it("applies a partial refund and leaves the balance refundable", async () => {
    const id = await createPayment();

    const refund = await request(ctx.app)
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

    await request(ctx.app).post(`/api/payments/${id}/refund`).send({ amount: 1000 });
    const second = await request(ctx.app).post(`/api/payments/${id}/refund`).send({ amount: 1200 });
    expect(second.body).toMatchObject({ status: "partially_refunded", amountRefunded: 2200 });

    // Omitting the amount refunds whatever balance is left.
    const third = await request(ctx.app).post(`/api/payments/${id}/refund`);
    expect(third.body).toMatchObject({
      status: "refunded",
      amountRefunded: 2500,
      amountRefundable: 0,
    });

    const detail = await request(ctx.app).get(`/api/payments/${id}`);
    expect(detail.body.refunds.map((r: { amount: number }) => r.amount)).toEqual([1000, 1200, 300]);
  });

  it("rejects a refund larger than the refundable balance", async () => {
    const id = await createPayment();
    await request(ctx.app).post(`/api/payments/${id}/refund`).send({ amount: 2000 });

    const tooBig = await request(ctx.app).post(`/api/payments/${id}/refund`).send({ amount: 900 });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toBe("refund_amount_too_large");

    // The failed refund must not have changed the payment.
    const detail = await request(ctx.app).get(`/api/payments/${id}`);
    expect(detail.body).toMatchObject({ amountRefunded: 2000, status: "partially_refunded" });
  });

  it("rejects a non-positive refund amount", async () => {
    const id = await createPayment();
    const res = await request(ctx.app).post(`/api/payments/${id}/refund`).send({ amount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("will not refund a declined payment", async () => {
    const id = await createPayment({ cardNumber: DECLINE });
    const refund = await request(ctx.app).post(`/api/payments/${id}/refund`);
    expect(refund.status).toBe(409);
    expect(refund.body.error).toBe("cannot_refund_declined");
  });

  it("returns 404 when refunding an unknown payment", async () => {
    const res = await request(ctx.app).post("/api/payments/pay_missing/refund");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("payment_not_found");
  });
});

describe("payment detail and timeline", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    closeContext(ctx.db);
  });

  const body = {
    amount: 2500,
    customerName: "Ada Lovelace",
    customerEmail: "ada@example.com",
    cardNumber: VISA,
  };

  it("records a timeline for a successful payment and its refunds", async () => {
    const created = await request(ctx.app).post("/api/payments").send(body);
    const id = created.body.id;
    await request(ctx.app).post(`/api/payments/${id}/refund`).send({ amount: 500, reason: "late" });
    await request(ctx.app).post(`/api/payments/${id}/refund`);

    const detail = await request(ctx.app).get(`/api/payments/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual([
      "payment.created",
      "payment.succeeded",
      "refund.created",
      "refund.created",
      "payment.refunded",
    ]);
    expect(detail.body.events[2].message).toContain("late");
    expect(detail.body.refunds).toHaveLength(2);
  });

  it("records a declined timeline", async () => {
    const created = await request(ctx.app)
      .post("/api/payments")
      .send({ ...body, cardNumber: DECLINE });
    const detail = await request(ctx.app).get(`/api/payments/${created.body.id}`);
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual([
      "payment.created",
      "payment.declined",
    ]);
    expect(detail.body.events[1].message).toContain("card_declined");
  });
});

describe("listing, filtering and pagination", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(async () => {
    ctx = createTestContext();

    const people = [
      { customerName: "Ada Lovelace", customerEmail: "ada@example.com", description: "Pro plan" },
      { customerName: "Grace Hopper", customerEmail: "grace@example.com", description: "Team plan" },
      { customerName: "Alan Turing", customerEmail: "alan@example.com", description: "Pro plan" },
    ];
    for (const person of people) {
      await request(ctx.app)
        .post("/api/payments")
        .send({ amount: 1000, cardNumber: VISA, ...person });
    }
    await request(ctx.app).post("/api/payments").send({
      amount: 5000,
      customerName: "Katherine Johnson",
      customerEmail: "katherine@example.com",
      description: "Enterprise",
      cardNumber: DECLINE,
    });
  });

  afterEach(() => {
    closeContext(ctx.db);
  });

  it("filters by status", async () => {
    const res = await request(ctx.app).get("/api/payments?status=declined");
    expect(res.body.total).toBe(1);
    expect(res.body.payments[0].customerName).toBe("Katherine Johnson");
  });

  it("searches across name, email and description", async () => {
    const byName = await request(ctx.app).get("/api/payments?q=grace");
    expect(byName.body.total).toBe(1);

    const byDescription = await request(ctx.app).get("/api/payments?q=Pro plan");
    expect(byDescription.body.total).toBe(2);

    const byEmail = await request(ctx.app).get("/api/payments?q=katherine@example.com");
    expect(byEmail.body.total).toBe(1);
  });

  it("combines a search term with a status filter", async () => {
    // The term alone matches every payment; the status narrows it to one.
    const termOnly = await request(ctx.app).get("/api/payments?q=example.com");
    expect(termOnly.body.total).toBe(4);

    const combined = await request(ctx.app).get("/api/payments?q=example.com&status=declined");
    expect(combined.body.total).toBe(1);
    expect(combined.body.payments[0].customerName).toBe("Katherine Johnson");
  });

  it("paginates with limit and offset while reporting the full total", async () => {
    const first = await request(ctx.app).get("/api/payments?limit=2&offset=0");
    expect(first.body).toMatchObject({ total: 4, limit: 2, offset: 0 });
    expect(first.body.payments).toHaveLength(2);

    const second = await request(ctx.app).get("/api/payments?limit=2&offset=2");
    expect(second.body.payments).toHaveLength(2);

    const firstIds = first.body.payments.map((p: { id: string }) => p.id);
    const secondIds = second.body.payments.map((p: { id: string }) => p.id);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });

  it("returns an empty page past the end of the result set", async () => {
    const res = await request(ctx.app).get("/api/payments?limit=2&offset=99");
    expect(res.body.total).toBe(4);
    expect(res.body.payments).toHaveLength(0);
  });

  it("rejects an out-of-range limit", async () => {
    const res = await request(ctx.app).get("/api/payments?limit=500");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("rejects an unknown status filter", async () => {
    const res = await request(ctx.app).get("/api/payments?status=bogus");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("treats blank query parameters as absent", async () => {
    const res = await request(ctx.app).get("/api/payments?status=&q=&limit=&offset=");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 4, limit: 25, offset: 0 });
  });
});

describe("idempotent payment creation", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    closeContext(ctx.db);
  });

  const body = {
    amount: 2500,
    customerName: "Ada Lovelace",
    customerEmail: "ada@example.com",
    cardNumber: VISA,
  };

  it("replays the original payment for a repeated key", async () => {
    const first = await request(ctx.app).post("/api/payments").set("Idempotency-Key", "key-1").send(body);
    expect(first.status).toBe(201);
    expect(first.headers["idempotency-replayed"]).toBe("false");

    const second = await request(ctx.app)
      .post("/api/payments")
      .set("Idempotency-Key", "key-1")
      .send(body);
    expect(second.status).toBe(201);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(second.body.id).toBe(first.body.id);

    const list = await request(ctx.app).get("/api/payments");
    expect(list.body.total).toBe(1);
  });

  it("rejects a key reused with different parameters", async () => {
    await request(ctx.app).post("/api/payments").set("Idempotency-Key", "key-2").send(body);
    const conflict = await request(ctx.app)
      .post("/api/payments")
      .set("Idempotency-Key", "key-2")
      .send({ ...body, amount: 9900 });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("idempotency_key_reuse");
  });

  it("creates separate payments for different keys", async () => {
    await request(ctx.app).post("/api/payments").set("Idempotency-Key", "key-3").send(body);
    await request(ctx.app).post("/api/payments").set("Idempotency-Key", "key-4").send(body);
    const list = await request(ctx.app).get("/api/payments");
    expect(list.body.total).toBe(2);
  });

  it("creates a new payment every time when no key is supplied", async () => {
    await request(ctx.app).post("/api/payments").send(body);
    await request(ctx.app).post("/api/payments").send(body);
    const list = await request(ctx.app).get("/api/payments");
    expect(list.body.total).toBe(2);
  });
});

describe("stats", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    closeContext(ctx.db);
  });

  const body = {
    customerName: "Ada Lovelace",
    customerEmail: "ada@example.com",
    cardNumber: VISA,
  };

  it("reports zeroes for an empty ledger", async () => {
    const res = await request(ctx.app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      count: 0,
      grossVolume: 0,
      refundedVolume: 0,
      netVolume: 0,
      currency: "usd",
    });
  });

  it("reports aggregate stats", async () => {
    const a = await request(ctx.app)
      .post("/api/payments")
      .send({ ...body, amount: 1000 });
    await request(ctx.app)
      .post("/api/payments")
      .send({ ...body, amount: 2000 });
    await request(ctx.app)
      .post("/api/payments")
      .send({ ...body, amount: 500, cardNumber: DECLINE });
    await request(ctx.app).post(`/api/payments/${a.body.id}/refund`);

    const res = await request(ctx.app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      count: 3,
      succeededCount: 1,
      partiallyRefundedCount: 0,
      refundedCount: 1,
      declinedCount: 1,
      grossVolume: 3000,
      refundedVolume: 1000,
      netVolume: 2000,
    });
  });

  it("counts partial refunds against net volume", async () => {
    const created = await request(ctx.app)
      .post("/api/payments")
      .send({ ...body, amount: 4000 });
    await request(ctx.app).post(`/api/payments/${created.body.id}/refund`).send({ amount: 1500 });

    const res = await request(ctx.app).get("/api/stats");
    expect(res.body).toMatchObject({
      count: 1,
      succeededCount: 0,
      partiallyRefundedCount: 1,
      grossVolume: 4000,
      refundedVolume: 1500,
      netVolume: 2500,
    });
  });
});

describe("schema migration", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cloud-pay-test-"));
    file = join(dir, "legacy.sqlite");

    // The schema as it shipped before partial refunds existed.
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
    const db = openDatabase(file);
    const service = new PaymentService(db);

    expect(service.get("pay_old_refunded")).toMatchObject({
      amountRefunded: 2500,
      amountRefundable: 0,
    });
    expect(service.get("pay_old_succeeded")).toMatchObject({
      amountRefunded: 0,
      amountRefundable: 1000,
    });

    db.close();
  });

  it("is safe to run twice and leaves migrated data untouched", () => {
    const first = openDatabase(file);
    new PaymentService(first).refund("pay_old_succeeded", { amount: 400, reason: "" });
    first.close();

    const second = openDatabase(file);
    const service = new PaymentService(second);
    expect(service.get("pay_old_succeeded")).toMatchObject({
      amountRefunded: 400,
      amountRefundable: 600,
      status: "partially_refunded",
    });
    expect(service.get("pay_old_refunded").amountRefunded).toBe(2500);
    second.close();
  });
});
