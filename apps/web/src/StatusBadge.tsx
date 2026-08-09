import { formatStatus } from "./api.js";

const KNOWN = new Set([
  "succeeded",
  "declined",
  "partially_refunded",
  "refunded",
  "active",
  "trialing",
  "past_due",
  "canceled",
  "pending",
  "paid",
  "delivered",
  "failed",
  "needs_response",
  "under_review",
  "won",
  "lost",
]);

export function StatusBadge({ status }: { status: string }) {
  const cls = KNOWN.has(status) ? `badge-${status}` : "badge-partially_refunded";
  return <span className={`badge ${cls}`}>{formatStatus(status)}</span>;
}
