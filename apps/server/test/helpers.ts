import type Database from "better-sqlite3";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createServices, type AppServices } from "../src/services/index.js";
import type { WebhookTransport } from "../src/services/webhooks.js";

export function createTestContext(
  options: { transport?: WebhookTransport; autoDeliver?: boolean } = {},
): AppServices & { app: ReturnType<typeof createApp> } {
  const db = openDatabase(":memory:");
  const services = createServices(db, {
    autoDeliver: options.autoDeliver ?? false,
    transport: options.transport,
  });
  return { ...services, app: createApp(services) };
}

export function closeContext(db: Database.Database): void {
  db.close();
}
