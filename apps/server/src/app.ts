import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import {
  createPaymentSchema,
  listPaymentsQuerySchema,
  PaymentError,
  PaymentService,
  refundPaymentSchema,
} from "./payments.js";

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

export function createApp(service: PaymentService): Express {
  const app = express();
  app.use(cors({ exposedHeaders: ["Idempotency-Replayed"] }));
  app.use(express.json());

  const api = express.Router();

  api.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "cloud-pay", time: new Date().toISOString() });
  });

  api.get("/stats", (_req, res) => {
    res.json(service.stats());
  });

  api.get("/payments", (req, res, next) => {
    try {
      res.json(service.list(listPaymentsQuerySchema.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  api.post("/payments", (req, res, next) => {
    try {
      const key = readIdempotencyKey(req);
      const input = createPaymentSchema.parse(req.body);
      const { payment, replayed } = service.create(input, key ? { key } : undefined);
      res.status(201).set("Idempotency-Replayed", String(replayed)).json(payment);
    } catch (err) {
      next(err);
    }
  });

  api.get("/payments/:id", (req, res, next) => {
    try {
      res.json(service.getDetail(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.post("/payments/:id/refund", (req, res, next) => {
    try {
      const input = refundPaymentSchema.parse(req.body ?? {});
      res.json(service.refund(req.params.id, input));
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
