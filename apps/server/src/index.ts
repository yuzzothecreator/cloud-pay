import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { createServices, startBackgroundWorkers } from "./services.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4000);
const DB_PATH = process.env.CLOUD_PAY_DB ?? resolve(__dirname, "..", "data", "cloud-pay.sqlite");
const REQUIRE_AUTH = process.env.CLOUD_PAY_REQUIRE_AUTH === "true";

const { db, defaultMerchantId, defaultApiKey } = openDatabase(DB_PATH);
const services = createServices(db, defaultMerchantId, REQUIRE_AUTH);
const app = createApp(services, defaultApiKey);
const workers = startBackgroundWorkers(services);

const server = app.listen(PORT, () => {
  console.log(`cloud-pay API listening on http://localhost:${PORT} (db: ${DB_PATH})`);
  if (defaultApiKey) {
    console.log(`Demo API key (also at GET /api/setup): ${defaultApiKey}`);
  }
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down.`);
  for (const timer of workers) clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
