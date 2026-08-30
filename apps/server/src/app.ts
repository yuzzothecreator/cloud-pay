import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { createPaymentSchema, PaymentError, PaymentService } from "./payments.js";

export function createApp(service: PaymentService): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const api = express.Router();

  api.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "cloud-pay", time: new Date().toISOString() });
  });

  api.get("/stats", (_req, res) => {
    res.json(service.stats());
  });

  api.get("/payments", (_req, res) => {
    res.json({ payments: service.list() });
  });

  api.post("/payments", (req, res, next) => {
    try {
      const input = createPaymentSchema.parse(req.body);
      const payment = service.create(input);
      res.status(201).json(payment);
    } catch (err) {
      next(err);
    }
  });

  api.get("/payments/:id", (req, res, next) => {
    try {
      res.json(service.get(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  api.post("/payments/:id/refund", (req, res, next) => {
    try {
      res.json(service.refund(req.params.id));
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
        message: "Request body is invalid",
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
