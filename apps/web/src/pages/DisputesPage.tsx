import { useCallback, useEffect, useState } from "react";
import {
  fetchDisputes,
  formatMoney,
  formatTimestamp,
  updateDispute,
  type Dispute,
  type DisputeStatus,
} from "../api.js";
import { StatusBadge } from "../StatusBadge.js";

const FILTERS = [
  { label: "All", value: "" },
  { label: "Needs response", value: "needs_response" },
  { label: "Under review", value: "under_review" },
  { label: "Won", value: "won" },
  { label: "Lost", value: "lost" },
  { label: "Withdrawn", value: "withdrawn" },
];

const NEXT_STATUSES: DisputeStatus[] = ["needs_response", "under_review", "won", "lost", "withdrawn"];

export function DisputesPage() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const page = await fetchDisputes({ status, limit: 50, offset: 0 });
    setDisputes(page.disputes);
  }, [status]);

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [refresh]);

  const onUpdate = async (id: string, next: DisputeStatus) => {
    setError(null);
    setNotice(null);
    try {
      const updated = await updateDispute(id, { status: next });
      setNotice(`Dispute ${updated.id} is now ${updated.status.replace(/_/g, " ")}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Disputes</h2>
      </div>

      <div className="filters">
        {FILTERS.map((filter) => (
          <button
            key={filter.value || "all"}
            type="button"
            className={`chip ${status === filter.value ? "chip-active" : ""}`}
            onClick={() => setStatus(filter.value)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {notice && <p className="alert alert-info">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}

      {disputes.length === 0 ? (
        <p className="empty">No disputes match this filter.</p>
      ) : (
        <table className="txns">
          <thead>
            <tr>
              <th>Dispute</th>
              <th>Amount</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {disputes.map((d) => (
              <tr key={d.id}>
                <td>
                  <div className="mono cust-name">{d.id}</div>
                  <div className="cust-sub mono">{d.paymentId}</div>
                  <div className="cust-sub">{formatTimestamp(d.createdAt)}</div>
                </td>
                <td>{formatMoney(d.amount, d.currency)}</td>
                <td>{d.reason.replace(/_/g, " ")}</td>
                <td>
                  <StatusBadge status={d.status} />
                </td>
                <td>
                  <div className="action-stack">
                    {NEXT_STATUSES.filter((s) => s !== d.status).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="chip"
                        disabled={["won", "lost", "withdrawn"].includes(d.status)}
                        onClick={() => void onUpdate(d.id, s)}
                      >
                        Mark {s.replace(/_/g, " ")}
                      </button>
                    ))}
                  </div>
                  {d.evidence && <div className="cust-sub">{d.evidence}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
