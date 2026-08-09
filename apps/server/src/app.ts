import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { analyticsQuerySchema } from "./analytics.js";
import { AppError } from "./errors.js";
import {
  createCustomerSchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from "./customers.js";
import { createDisputeSchema, listDisputesQuerySchema, resolveDisputeSchema } from "./disputes.js";
import {
  createPaymentSchema,
  listPaymentsQuerySchema,
  PaymentError,
  refundPaymentSchema,
} from "./payments.js";
import { createPayoutSchema, listPayoutsQuerySchema } from "./payouts.js";
import {
  createPriceSchema,
  createProductSchema,
  listProductsQuerySchema,
} from "./products.js";
import type { AppServices } from "./services.js";
import { createSubscriptionSchema, listSubscriptionsQuerySchema } from "./subscriptions.js";
import { createWebhookSchema, listDeliveriesQuerySchema } from "./webhooks.js";

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function readIdempotencyKey(req: Request): string | undefined {
  const key = req.header("Idempotency-Key")?.trim();
  if (!key) return undefined;
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new PaymentError(
      400,
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      "invalid_idempotency_key",
    );
  }
  return key;
}

function merchantId(req: Request): string {
  return req.auth!.merchantId;
}

export function createApp(services: AppServices, defaultApiKey: string | null): Express {
  const app = express();
  app.use(cors({ exposedHeaders: ["Idempotency-Replayed"] }));
  app.use(express.json());
  app.use(services.auth.middleware());

  const api = express.Router();

  api.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "cloud-pay",
      version: "0.2.0",
      time: new Date().toISOString(),
    });
  });

  if (defaultApiKey) {
    api.get("/setup", (_req, res) => {
      res.json({
        message: "Use this API key in the Authorization header as Bearer <key>",
        apiKey: defaultApiKey,
      });
    });
  }

  api.get("/stats", (req, res, next) => {
    try {
      res.json(services.payments.stats(merchantId(req)));
    } catch (err) {
      next(err);
    }
  });

  api.get("/analytics", (req, res, next) => {
    try {
      res.json(services.analytics.report(merchantId(req), analyticsQuerySchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  api.get("/balance", (req, res, next) => {
    try {
      res.json(services.payouts.balance(merchantId(req)));
    } catch (err) {
      next(err);
    }
  });

  // Payments
  api.get("/payments", (req, res, next) => {
    try {
      res.json(services.payments.list(merchantId(req), listPaymentsQuerySchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  api.post("/payments", (req, res, next) => {
    try {
      const key = readIdempotencyKey(req);
      const input = createPaymentSchema.parse(req.body);
      const { payment, replayed } = services.payments.create(
        input,
        merchantId(req),
        key ? { key } : undefined,
      );
      res.status(201).set("Idempotency-Replayed", String(replayed)).json(payment);
    } catch (err) {
      next(err);
    }
  });

  api.get("/payments/:id", (req, res, next) => {
    try {
      res.json(services.payments.getDetail(req.params.id, merchantId(req)));
    } catch (err) {
      next(err);
    }
  });

  api.post("/payments/:id/refund", (req, res, next) => {
    try {
      const input = refundPaymentSchema.parse(req.body ?? {});
      res.json(services.payments.refund(req.params.id, merchantId(req), input));
    } catch (err) {
      next(err);
    }
  });

  // Customers
  api.get("/customers", (req, res, next) => {
    try {
      res.json(services.customers.list(merchantId(req), listCustomersQuerySchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  api.post("/customers", (req, res, next) => {
    try {
      const input = createCustomerSchema.parse(req.body);
      res.status(201).json(services.customers.create(merchantId(req), input));
    } catch (err) {
      next(err);
    }
  });

  api.get("/customers/:id", (req, res, next) => {
    try {
      res.json(services.customers.get(merchantId(req), req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.patch("/customers/:id", (req, res, next) => {
    try {
      const input = updateCustomerSchema.parse(req.body);
      res.json(services.customers.update(merchantId(req), req.params.id, input));
    } catch (err) {
      next(err);
    }
  });

  api.delete("/customers/:id", (req, res, next) => {
    try {
      services.customers.delete(merchantId(req), req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Products & prices
  api.get("/products", (req, res, next) => {
    try {
      res.json(services.products.list(merchantId(req), listProductsQuerySchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  api.post("/products", (req, res, next) => {
    try {
      const input = createProductSchema.parse(req.body);
      res.status(201).json(services.products.create(merchantId(req), input));
    } catch (err) {
      next(err);
    }
  });

  api.get("/products/:id", (req, res, next) => {
    try {
      res.json(services.products.get(merchantId(req), req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.post("/products/:id/prices", (req, res, next) => {
    try {
      const input = createPriceSchema.parse(req.body);
      res.status(201).json(services.products.addPrice(merchantId(req), req.params.id, input));
    } catch (err) {
      next(err);
    }
  });

  // Subscriptions
  api.get("/subscriptions", (req, res, next) => {
    try {
      res.json(
        services.subscriptions.list(merchantId(req), listSubscriptionsQuerySchema.parse(req.query)),
      );
    } catch (err) {
      next(err);
    }
  });

  api.post("/subscriptions", (req, res, next) => {
    try {
      const input = createSubscriptionSchema.parse(req.body);
      res.status(201).json(services.subscriptions.create(merchantId(req), input));
    } catch (err) {
      next(err);
    }
  });

  api.get("/subscriptions/:id", (req, res, next) => {
    try {
      res.json(services.subscriptions.get(merchantId(req), req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.post("/subscriptions/:id/cancel", (req, res, next) => {
    try {
      const atPeriodEnd = req.body?.atPeriodEnd !== false;
      res.json(services.subscriptions.cancel(merchantId(req), req.params.id, atPeriodEnd));
    } catch (err) {
      next(err);
    }
  });

  // Webhooks
  api.get("/webhooks", (req, res, next) => {
    try {
      res.json({ endpoints: services.webhooks.list(merchantId(req)) });
    } catch (err) {
      next(err);
    }
  });

  api.post("/webhooks", (req, res, next) => {
    try {
      const input = createWebhookSchema.parse(req.body);
      res.status(201).json(services.webhooks.create(merchantId(req), input));
    } catch (err) {
      next(err);
    }
  });

  api.delete("/webhooks/:id", (req, res, next) => {
    try {
      services.webhooks.delete(merchantId(req), req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  api.get("/webhook-deliveries", (req, res, next) => {
    try {
      res.json(
        services.webhooks.listDeliveries(merchantId(req), listDeliveriesQuerySchema.parse(req.query)),
      );
    } catch (err) {
      next(err);
    }
  });

  // Disputes
  api.get("/disputes", (req, res, next) => {
    try {
      res.json(services.disputes.list(merchantId(req), listDisputesQuerySchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  api.post("/disputes", (req, res, next) => {
    try {
      const input = createDisputeSchema.parse(req.body);
      res.status(201).json(services.disputes.create(merchantId(req), input));
    } catch (err) {
      next(err);
    }
  });

  api.get("/disputes/:id", (req, res, next) => {
    try {
      res.json(services.disputes.get(merchantId(req), req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.post("/disputes/:id/evidence", (req, res, next) => {
    try {
      res.json(services.disputes.submitEvidence(merchantId(req), req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.post("/disputes/:id/resolve", (req, res, next) => {
    try {
      const input = resolveDisputeSchema.parse(req.body);
      res.json(services.disputes.resolve(merchantId(req), req.params.id, input));
    } catch (err) {
      next(err);
    }
  });

  // Payouts
  api.get("/payouts", (req, res, next) => {
    try {
      res.json(services.payouts.list(merchantId(req), listPayoutsQuerySchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  api.post("/payouts", (req, res, next) => {
    try {
      const input = createPayoutSchema.parse(req.body);
      res.status(201).json(services.payouts.create(merchantId(req), input));
    } catch (err) {
      next(err);
    }
  });

  // API keys
  api.get("/api-keys", (req, res, next) => {
    try {
      res.json({ keys: services.auth.listKeys(merchantId(req)) });
    } catch (err) {
      next(err);
    }
  });

  api.post("/api-keys", (req, res, next) => {
    try {
      const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : "API key";
      res.status(201).json(services.auth.createKey(merchantId(req), name));
    } catch (err) {
      next(err);
    }
  });

  api.delete("/api-keys/:id", (req, res, next) => {
    try {
      services.auth.revokeKey(merchantId(req), req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.use("/api", api);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: "validation_error",
        message: "Request is invalid",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    if (err instanceof AppError || err instanceof PaymentError) {
      res.status(err.statusCode).json({ error: err.code, message: err.message });
      return;
    }
    console.error("Unexpected error:", err);
    res.status(500).json({ error: "internal_error", message: "Something went wrong" });
  });

  return app;
}
