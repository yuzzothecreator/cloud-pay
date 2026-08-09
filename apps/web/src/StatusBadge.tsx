import { formatStatus } from "./api.js";

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{formatStatus(status)}</span>;
}
