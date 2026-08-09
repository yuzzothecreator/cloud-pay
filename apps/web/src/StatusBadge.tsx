import { formatStatus, type PaymentStatus } from "./api.js";

export function StatusBadge({ status }: { status: PaymentStatus }) {
  return <span className={`badge badge-${status}`}>{formatStatus(status)}</span>;
}
