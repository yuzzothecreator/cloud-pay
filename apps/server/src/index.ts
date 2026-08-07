import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { PaymentService } from "./payments.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4000);
const DB_PATH = process.env.CLOUD_PAY_DB ?? resolve(__dirname, "..", "data", "cloud-pay.sqlite");

const db = openDatabase(DB_PATH);
const service = new PaymentService(db);
const app = createApp(service);

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
