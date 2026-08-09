import type { NextFunction, Request, Response } from "express";
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { AppError } from "./errors.js";
import { hashApiKey } from "./db.js";
import { newId } from "./ids.js";

export interface AuthContext {
  merchantId: string;
  apiKeyId: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export class AuthService {
  constructor(
    private readonly db: Database.Database,
    private readonly defaultMerchantId: string,
    private readonly requireAuth: boolean,
  ) {}

  middleware() {
    return (req: Request, _res: Response, next: NextFunction) => {
      try {
        req.auth = this.resolve(req);
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  resolve(req: Request): AuthContext {
    const header = req.header("Authorization")?.trim();
    if (!header) {
      if (this.requireAuth) {
        throw new AppError(401, "Missing Authorization header", "unauthorized");
      }
      return { merchantId: this.defaultMerchantId, apiKeyId: "anonymous" };
    }

    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      throw new AppError(401, "Authorization must be Bearer <api_key>", "unauthorized");
    }

    const key = match[1];
    const row = this.db
      .prepare(
        `SELECT id, merchant_id FROM api_keys WHERE key_hash = ?`,
      )
      .get(hashApiKey(key)) as { id: string; merchant_id: string } | undefined;

    if (!row) {
      throw new AppError(401, "Invalid API key", "invalid_api_key");
    }

    this.db
      .prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), row.id);

    return { merchantId: row.merchant_id, apiKeyId: row.id };
  }

  listKeys(merchantId: string) {
    return this.db
      .prepare(
        `SELECT id, prefix, name, created_at AS createdAt, last_used_at AS lastUsedAt
         FROM api_keys WHERE merchant_id = ? ORDER BY created_at DESC`,
      )
      .all(merchantId);
  }

  createKey(merchantId: string, name: string): { id: string; key: string; prefix: string; name: string } {
    const rawKey = `cpk_live_${randomBytes(24).toString("hex")}`;
    const id = newId("key");
    const prefix = rawKey.slice(0, 12);
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO api_keys (id, merchant_id, key_hash, prefix, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, merchantId, hashApiKey(rawKey), prefix, name, createdAt);
    return { id, key: rawKey, prefix, name };
  }

  revokeKey(merchantId: string, keyId: string): void {
    const result = this.db
      .prepare(`DELETE FROM api_keys WHERE id = ? AND merchant_id = ?`)
      .run(keyId, merchantId);
    if (result.changes === 0) {
      throw new AppError(404, "API key not found", "api_key_not_found");
    }
  }
}
