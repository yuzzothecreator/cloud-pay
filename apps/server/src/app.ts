import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import {
  capturePaymentSchema,
  createPaymentSchema,
  listPaymentsQuerySchema,
  PaymentError,
  refundPaymentSchema,
} from "./payments.js";
import { analyticsQuerySchema } from "./services/analytics.js";
import { createApiKeySchema } from "./services/apiKeys.js";
import {
  listCustomersQuerySchema,
  upsertCustomerSchema,
} from "./services/customers.js";
import {
  createDisputeSchema,
  listDisputesQuerySchema,
  updateDisputeSchema,
} from "./services/disputes.js";
import type { AppServices } from "./services/index.js";
import {
  createWebhookEndpointSchema,
  updateWebhookEndpointSchema,
} from "./services/webhooks.js";

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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKeyId?: string;
    }
  }
}

export function createApp(services: AppServices): Express {
  const app = express();
  app.use(cors({ exposedHeaders: ["Idempotency-Replayed"] }));
  app.use(express.json({ limit: "1mb" }));

  const requireAuth = process.env.CLOUD_PAY_REQUIRE_AUTH === "1";

  app.use("/api", (req, res, next) => {
    // Health stays public so probes keep working when auth is enforced.
    if (req.path === "/health") return next();

    const header = req.header("Authorization");
    if (!header) {
      if (requireAuth) {
        return res.status(401).json({
          error: "authentication_required",
          message: "Provide Authorization: Bearer <api_key>",
        });
      }
      return next();
    }

    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return res.status(401).json({
        error: "invalid_authorization",
        message: "Authorization header must be Bearer <api_key>",
      });
    }

    try {
      const key = services.apiKeys.authenticate(match[1]!);
      req.apiKeyId = key.id;
      next();
    } catch (err) {
      next(err);
    }
  });

  const api = express.Router();

  api.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "cloud-pay", time: new Date().toISOString() });
  });

  api.get("/stats", (_req, res) => {
    res.json(services.payments.stats());
  });

  api.get("/analytics", (req, res, next) => {
    try {
      res.json(services.analytics.snapshot(analyticsQuerySchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  api.get("/payments/export.csv", (_req, res) => {
    res
      .type("text/csv")
      .set("Content-Disposition", 'attachment; filename="cloud-pay-payments.csv"')
      .send(services.payments.exportCsv());
  });

  api.get("/payments", (req, res, next) => {
    try {
      res.json(services.payments.list(listPaymentsQuerySchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  api.post("/payments", (req, res, next) => {
    try {
      const key = readIdempotencyKey(req);
      const input = createPaymentSchema.parse(req.body);
      const { payment, replayed } = services.payments.create(input, key ? { key } : undefined);
      res.status(201).set("Idempotency-Replayed", String(replayed)).json(payment);
    } catch (err) {
      next(err);
    }
  });

  api.get("/payments/:id", (req, res, next) => {
    try {
      res.json(services.payments.getDetail(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.post("/payments/:id/refund", (req, res, next) => {
    try {
      const input = refundPaymentSchema.parse(req.body ?? {});
      res.json(services.payments.refund(req.params.id, input));
    } catch (err) {
      next(err);
    }
  });

  api.post("/payments/:id/capture", (req, res, next) => {
    try {
      const input = capturePaymentSchema.parse(req.body ?? {});
      res.json(services.payments.capture(req.params.id, input));
    } catch (err) {
      next(err);
    }
  });

  api.post("/payments/:id/cancel", (req, res, next) => {
    try {
      res.json(services.payments.cancel(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.post("/payments/:id/disputes", (req, res, next) => {
    try {
      const input = createDisputeSchema.parse(req.body ?? {});
      res.status(201).json(services.disputes.create(req.params.id, input));
    } catch (err) {
      next(err);
    }
  });

  api.get("/customers", (req, res, next) => {
    try {
      res.json(services.customers.list(listCustomersQuerySchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  api.post("/customers", (req, res, next) => {
    try {
      res.status(201).json(services.customers.upsert(upsertCustomerSchema.parse(req.body)));
    } catch (err) {
      next(err);
    }
  });

  api.get("/customers/:id", (req, res, next) => {
    try {
      res.json(services.customers.get(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.get("/disputes", (req, res, next) => {
    try {
      res.json(services.disputes.list(listDisputesQuerySchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  api.get("/disputes/:id", (req, res, next) => {
    try {
      res.json(services.disputes.get(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.patch("/disputes/:id", (req, res, next) => {
    try {
      res.json(services.disputes.update(req.params.id, updateDisputeSchema.parse(req.body ?? {})));
    } catch (err) {
      next(err);
    }
  });

  api.get("/webhooks/endpoints", (_req, res) => {
    res.json({ endpoints: services.webhooks.list() });
  });

  api.post("/webhooks/endpoints", (req, res, next) => {
    try {
      res.status(201).json(services.webhooks.create(createWebhookEndpointSchema.parse(req.body)));
    } catch (err) {
      next(err);
    }
  });

  api.patch("/webhooks/endpoints/:id", (req, res, next) => {
    try {
      res.json(
        services.webhooks.update(req.params.id, updateWebhookEndpointSchema.parse(req.body ?? {})),
      );
    } catch (err) {
      next(err);
    }
  });

  api.delete("/webhooks/endpoints/:id", (req, res, next) => {
    try {
      services.webhooks.remove(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  api.get("/webhooks/deliveries", (req, res) => {
    const endpointId =
      typeof req.query.endpointId === "string" ? req.query.endpointId : undefined;
    res.json({ deliveries: services.webhooks.listDeliveries(endpointId) });
  });

  api.post("/webhooks/deliveries/:id/retry", async (req, res, next) => {
    try {
      res.json(await services.webhooks.retry(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.get("/api-keys", (_req, res) => {
    res.json({ keys: services.apiKeys.list() });
  });

  api.post("/api-keys", (req, res, next) => {
    try {
      res.status(201).json(services.apiKeys.create(createApiKeySchema.parse(req.body)));
    } catch (err) {
      next(err);
    }
  });

  api.post("/api-keys/:id/revoke", (req, res, next) => {
    try {
      res.json(services.apiKeys.revoke(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.use("/api", api);

  // Centralised error handling.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: "validation_error",
        message: "Request is invalid",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    if (err instanceof PaymentError) {
      res.status(err.statusCode).json({ error: err.code, message: err.message });
      return;
    }
    console.error("Unexpected error:", err);
    res.status(500).json({ error: "internal_error", message: "Something went wrong" });
  });

  return app;
}
