import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ApiKeyRow } from "../db.js";
import { PaymentError } from "../lib/errors.js";
import { prefixedId } from "../lib/ids.js";

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreatedApiKey extends ApiKey {
  /** Full secret — only returned once at creation time. */
  secret: string;
}

function hashKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export class ApiKeyService {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateApiKeyInput): CreatedApiKey {
    const id = prefixedId("key");
    const raw = randomBytes(24).toString("base64url");
    const secret = `cp_live_${raw}`;
    const prefix = secret.slice(0, 14);
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, prefix, key_hash, last_used_at, created_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(id, input.name, prefix, hashKey(secret), createdAt);

    return {
      id,
      name: input.name,
      prefix,
      secret,
      lastUsedAt: null,
      createdAt,
      revokedAt: null,
    };
  }

  list(): ApiKey[] {
    const rows = this.db
      .prepare(`SELECT * FROM api_keys ORDER BY created_at DESC, rowid DESC`)
      .all() as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  revoke(id: string): ApiKey {
    const row = this.db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(id) as
      | ApiKeyRow
      | undefined;
    if (!row) {
      throw new PaymentError(404, `API key ${id} not found`, "api_key_not_found");
    }
    if (row.revoked_at) {
      throw new PaymentError(409, "API key is already revoked", "api_key_already_revoked");
    }
    const revokedAt = new Date().toISOString();
    this.db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).run(revokedAt, id);
    return { ...rowToApiKey(row), revokedAt };
  }

  /** Validates a bearer secret and stamps last_used_at on success. */
  authenticate(secret: string): ApiKey {
    const row = this.db
      .prepare(`SELECT * FROM api_keys WHERE key_hash = ?`)
      .get(hashKey(secret)) as ApiKeyRow | undefined;

    if (!row || row.revoked_at) {
      throw new PaymentError(401, "Invalid or revoked API key", "invalid_api_key");
    }

    const lastUsedAt = new Date().toISOString();
    this.db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(lastUsedAt, row.id);
    return { ...rowToApiKey(row), lastUsedAt };
  }
}
