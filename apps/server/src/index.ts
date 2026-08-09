import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { seedIfEmpty } from "./seed.js";
import { createServices } from "./services/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4000);
const DB_PATH = process.env.CLOUD_PAY_DB ?? resolve(__dirname, "..", "data", "cloud-pay.sqlite");
const SEED = process.env.CLOUD_PAY_SEED !== "0";

const db = openDatabase(DB_PATH);
const services = createServices(db, {
  // Demo webhook endpoint points at example.com — don't spam the network on boot.
  autoDeliver: process.env.CLOUD_PAY_WEBHOOK_AUTO_DELIVER === "1",
});

if (SEED) {
  seedIfEmpty(services);
}

const app = createApp(services);

const server = app.listen(PORT, () => {
  console.log(`cloud-pay API listening on http://localhost:${PORT} (db: ${DB_PATH})`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down.`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
