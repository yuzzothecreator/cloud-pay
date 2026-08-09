import { createHmac } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signWebhookPayload } from "../src/services/webhooks.js";
import { closeContext, createTestContext } from "./helpers.js";

const VISA = "4242424242424242";

const body = {
  amount: 2500,
  customerName: "Ada Lovelace",
  customerEmail: "ada@example.com",
  cardNumber: VISA,
};

describe("customers", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    closeContext(ctx.db);
  });

  it("auto-creates a customer when a payment is charged", async () => {
    const payment = await request(ctx.app).post("/api/payments").send(body);
    expect(payment.status).toBe(201);
    expect(payment.body.customerId).toMatch(/^cus_/);

    const customers = await request(ctx.app).get("/api/customers");
    expect(customers.body.total).toBe(1);
    expect(customers.body.customers[0]).toMatchObject({
      email: "ada@example.com",
      paymentCount: 1,
      lifetimeValue: 2500,
    });
  });

  it("reuses the same customer for the same email", async () => {
    await request(ctx.app).post("/api/payments").send(body);
    await request(ctx.app).post("/api/payments").send({ ...body, amount: 1000 });

    const customers = await request(ctx.app).get("/api/customers");
    expect(customers.body.total).toBe(1);
    expect(customers.body.customers[0].paymentCount).toBe(2);
    expect(customers.body.customers[0].lifetimeValue).toBe(3500);
  });

  it("upserts a customer via the customers API", async () => {
    const res = await request(ctx.app).post("/api/customers").send({
      name: "Grace Hopper",
      email: "grace@example.com",
      phone: "+1 555 0100",
      metadata: { tier: "gold" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Grace Hopper",
      email: "grace@example.com",
      metadata: { tier: "gold" },
    });
  });
});

describe("authorize and capture", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    closeContext(ctx.db);
  });

  it("authorises a manual-capture payment and later captures it", async () => {
    const created = await request(ctx.app)
      .post("/api/payments")
      .send({ ...body, captureMethod: "manual" });

    expect(created.body).toMatchObject({
      status: "requires_capture",
      amountCapturable: 2500,
      amountRefundable: 0,
    });

    const captured = await request(ctx.app)
      .post(`/api/payments/${created.body.id}/capture`)
      .send({ amount: 2000 });

    expect(captured.body).toMatchObject({
      status: "succeeded",
      amount: 2000,
      amountCapturable: 0,
      amountRefundable: 2000,
    });

    const detail = await request(ctx.app).get(`/api/payments/${created.body.id}`);
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual([
      "payment.created",
      "payment.authorized",
      "payment.captured",
      "payment.succeeded",
    ]);
  });

  it("cancels an uncaptured authorisation", async () => {
    const created = await request(ctx.app)
      .post("/api/payments")
      .send({ ...body, captureMethod: "manual" });

    const canceled = await request(ctx.app).post(`/api/payments/${created.body.id}/cancel`);
    expect(canceled.body.status).toBe("canceled");
    expect(canceled.body.amountCapturable).toBe(0);

    const refund = await request(ctx.app).post(`/api/payments/${created.body.id}/refund`);
    expect(refund.status).toBe(409);
    expect(refund.body.error).toBe("cannot_refund_uncaptured");
  });

  it("rejects capturing more than the authorised amount", async () => {
    const created = await request(ctx.app)
      .post("/api/payments")
      .send({ ...body, captureMethod: "manual" });

    const res = await request(ctx.app)
      .post(`/api/payments/${created.body.id}/capture`)
      .send({ amount: 99999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("capture_amount_too_large");
  });
});

describe("disputes", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    closeContext(ctx.db);
  });

  it("opens, updates and closes a dispute", async () => {
    const payment = await request(ctx.app).post("/api/payments").send(body);

    const opened = await request(ctx.app)
      .post(`/api/payments/${payment.body.id}/disputes`)
      .send({ reason: "fraudulent", evidence: "chargeback notice" });

    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({
      status: "needs_response",
      reason: "fraudulent",
      amount: 2500,
    });

    const updated = await request(ctx.app)
      .patch(`/api/disputes/${opened.body.id}`)
      .send({ status: "under_review", evidence: "receipts attached" });
    expect(updated.body.status).toBe("under_review");

    const won = await request(ctx.app)
      .patch(`/api/disputes/${opened.body.id}`)
      .send({ status: "won" });
    expect(won.body.status).toBe("won");

    const again = await request(ctx.app)
      .patch(`/api/disputes/${opened.body.id}`)
      .send({ status: "lost" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("dispute_closed");
  });

  it("blocks a second open dispute on the same payment", async () => {
    const payment = await request(ctx.app).post("/api/payments").send(body);
    await request(ctx.app).post(`/api/payments/${payment.body.id}/disputes`).send({});
    const second = await request(ctx.app)
      .post(`/api/payments/${payment.body.id}/disputes`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("dispute_already_open");
  });

  it("lists disputes with a status filter", async () => {
    const payment = await request(ctx.app).post("/api/payments").send(body);
    const dispute = await request(ctx.app)
      .post(`/api/payments/${payment.body.id}/disputes`)
      .send({});
    await request(ctx.app).patch(`/api/disputes/${dispute.body.id}`).send({ status: "won" });

    const open = await request(ctx.app).get("/api/disputes?status=needs_response");
    expect(open.body.total).toBe(0);

    const won = await request(ctx.app).get("/api/disputes?status=won");
    expect(won.body.total).toBe(1);
  });
});

describe("webhooks", () => {
  let deliveries: Array<{ url: string; headers: Record<string, string>; body: string }>;
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    deliveries = [];
    ctx = createTestContext({
      autoDeliver: true,
      transport: async (url, headers, body) => {
        deliveries.push({ url, headers, body });
        return { status: 200, body: "ok" };
      },
    });
  });

  afterEach(() => {
    closeContext(ctx.db);
  });

  it("delivers signed webhook events for payment creation", async () => {
    const endpoint = await request(ctx.app).post("/api/webhooks/endpoints").send({
      url: "https://hooks.test/cloud-pay",
      events: ["payment.succeeded", "payment.created"],
    });
    expect(endpoint.status).toBe(201);
    expect(endpoint.body.secret).toMatch(/^whsec_/);

    await request(ctx.app).post("/api/payments").send(body);

    // Allow async deliveries to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    const first = deliveries[0]!;
    expect(first.url).toBe("https://hooks.test/cloud-pay");
    expect(first.headers["X-Cloud-Pay-Signature"]).toMatch(/^t=\d+,v1=[a-f0-9]+$/);

    const timestamp = first.headers["X-Cloud-Pay-Timestamp"];
    const expected = signWebhookPayload(endpoint.body.secret, timestamp, first.body);
    expect(first.headers["X-Cloud-Pay-Signature"]).toBe(`t=${timestamp},v1=${expected}`);

    const listed = await request(ctx.app).get("/api/webhooks/deliveries");
    expect(listed.body.deliveries.length).toBeGreaterThanOrEqual(1);
    expect(listed.body.deliveries[0].status).toBe("delivered");
  });

  it("retries a failed delivery", async () => {
    let attempts = 0;
    closeContext(ctx.db);
    ctx = createTestContext({
      autoDeliver: true,
      transport: async () => {
        attempts += 1;
        if (attempts === 1) return { status: 500, body: "nope" };
        return { status: 200, body: "ok" };
      },
    });

    await request(ctx.app).post("/api/webhooks/endpoints").send({
      url: "https://hooks.test/retry",
      events: ["*"],
    });
    await request(ctx.app).post("/api/payments").send(body);
    await new Promise((r) => setTimeout(r, 50));

    const listed = await request(ctx.app).get("/api/webhooks/deliveries");
    const failed = listed.body.deliveries.find(
      (d: { status: string }) => d.status === "failed",
    );
    expect(failed).toBeTruthy();

    const retried = await request(ctx.app).post(
      `/api/webhooks/deliveries/${failed.id}/retry`,
    );
    expect(retried.body.status).toBe("delivered");
    expect(retried.body.attempts).toBe(2);
  });

  it("verifies the HMAC helper against a known vector", () => {
    const bodyJson = '{"hello":"world"}';
    const timestamp = "1700000000";
    const secret = "whsec_test";
    const sig = signWebhookPayload(secret, timestamp, bodyJson);
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${bodyJson}`)
      .digest("hex");
    expect(sig).toBe(expected);
  });
});

describe("api keys", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    closeContext(ctx.db);
    delete process.env.CLOUD_PAY_REQUIRE_AUTH;
  });

  it("creates, authenticates and revokes an API key", async () => {
    const created = await request(ctx.app)
      .post("/api/api-keys")
      .send({ name: "CI key" });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^cp_live_/);

    const ok = await request(ctx.app)
      .get("/api/stats")
      .set("Authorization", `Bearer ${created.body.secret}`);
    expect(ok.status).toBe(200);

    const revoked = await request(ctx.app).post(`/api/api-keys/${created.body.id}/revoke`);
    expect(revoked.body.revokedAt).toBeTruthy();

    const denied = await request(ctx.app)
      .get("/api/stats")
      .set("Authorization", `Bearer ${created.body.secret}`);
    expect(denied.status).toBe(401);
    expect(denied.body.error).toBe("invalid_api_key");
  });
});

describe("analytics and export", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    closeContext(ctx.db);
  });

  it("returns a daily analytics snapshot", async () => {
    await request(ctx.app).post("/api/payments").send(body);
    await request(ctx.app).post("/api/payments").send({ ...body, amount: 1000 });

    const res = await request(ctx.app).get("/api/analytics?days=7");
    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(7);
    expect(res.body.totals.count).toBe(2);
    expect(res.body.totals.volume).toBe(3500);
    expect(res.body.topCustomers[0].email).toBe("ada@example.com");
  });

  it("exports payments as CSV", async () => {
    await request(ctx.app).post("/api/payments").send(body);
    const res = await request(ctx.app).get("/api/payments/export.csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text.split("\n")[0]).toContain("customer_email");
    expect(res.text).toContain("ada@example.com");
  });

  it("stores metadata and statement descriptors on payments", async () => {
    const res = await request(ctx.app)
      .post("/api/payments")
      .send({
        ...body,
        metadata: { orderId: "ord_1", channel: "web" },
        statementDescriptor: "CLOUDPAY*ADA",
      });
    expect(res.body.metadata).toEqual({ orderId: "ord_1", channel: "web" });
    expect(res.body.statementDescriptor).toBe("CLOUDPAY*ADA");
  });
});
