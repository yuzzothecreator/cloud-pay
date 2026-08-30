import type Database from "better-sqlite3";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { isLuhnValid, PaymentService } from "../src/payments.js";

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
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    app = createApp(new PaymentService(db));
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

  it("creates a succeeded payment", async () => {
    const res = await request(app).post("/api/payments").send(validBody);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      amount: 2500,
      currency: "usd",
      status: "succeeded",
      cardLast4: "4242",
      cardBrand: "visa",
    });
    expect(res.body.id).toMatch(/^pay_/);
  });

  it("declines a known test decline card", async () => {
    const res = await request(app)
      .post("/api/payments")
      .send({ ...validBody, cardNumber: DECLINE });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("declined");
    expect(res.body.failureReason).toBe("card_declined");
  });

  it("rejects an invalid card number with 400", async () => {
    const res = await request(app)
      .post("/api/payments")
      .send({ ...validBody, cardNumber: INVALID });
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
    await request(app).post("/api/payments").send({ ...validBody, description: "first" });
    await request(app).post("/api/payments").send({ ...validBody, description: "second" });
    const res = await request(app).get("/api/payments");
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
  });

  it("refunds a succeeded payment and blocks double refunds", async () => {
    const created = await request(app).post("/api/payments").send(validBody);
    const id = created.body.id;

    const refund = await request(app).post(`/api/payments/${id}/refund`);
    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe("refunded");

    const again = await request(app).post(`/api/payments/${id}/refund`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_refunded");
  });

  it("will not refund a declined payment", async () => {
    const created = await request(app)
      .post("/api/payments")
      .send({ ...validBody, cardNumber: DECLINE });
    const refund = await request(app).post(`/api/payments/${created.body.id}/refund`);
    expect(refund.status).toBe(409);
    expect(refund.body.error).toBe("cannot_refund_declined");
  });

  it("reports aggregate stats", async () => {
    const a = await request(app).post("/api/payments").send({ ...validBody, amount: 1000 });
    await request(app).post("/api/payments").send({ ...validBody, amount: 2000 });
    await request(app)
      .post("/api/payments")
      .send({ ...validBody, amount: 500, cardNumber: DECLINE });
    await request(app).post(`/api/payments/${a.body.id}/refund`);

    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      count: 3,
      succeededCount: 1,
      refundedCount: 1,
      declinedCount: 1,
      grossVolume: 3000,
      netVolume: 2000,
    });
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
