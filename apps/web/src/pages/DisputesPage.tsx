import { useEffect, useState } from "react";
import {
  createDispute,
  fetchDisputes,
  fetchPayments,
  formatMoney,
  formatTimestamp,
  resolveDispute,
  submitDisputeEvidence,
  type Dispute,
  type Payment,
} from "../api.js";
import { StatusBadge } from "../StatusBadge.js";

export function DisputesPage() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentId, setPaymentId] = useState("");
  const [reason, setReason] = useState("fraudulent");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [d, p] = await Promise.all([fetchDisputes(), fetchPayments({ status: "succeeded", limit: 20 })]);
    setDisputes(d.disputes);
    setPayments(p.payments);
    if (!paymentId && p.payments[0]) setPaymentId(p.payments[0].id);
  };

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createDispute({ paymentId, reason });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onEvidence = async (id: string) => {
    setError(null);
    try {
      await submitDisputeEvidence(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onResolve = async (id: string, outcome: "won" | "lost") => {
    setError(null);
    try {
      await resolveDispute(id, outcome);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page-content">
      <header className="page-header">
        <h1>Disputes</h1>
        <p className="page-sub">Chargeback simulation with evidence and resolution</p>
      </header>

      <div className="grid-2">
        <section className="panel">
          <h2>Open dispute</h2>
          <form className="form form-single" onSubmit={onSubmit}>
            <label className="full">
              Payment
              <select value={paymentId} onChange={(e) => setPaymentId(e.target.value)} required>
                {payments.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.customerName} — {formatMoney(p.amount, p.currency)} ({p.id})
                  </option>
                ))}
              </select>
            </label>
            <label className="full">
              Reason
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="fraudulent">Fraudulent</option>
                <option value="duplicate">Duplicate</option>
                <option value="product_not_received">Product not received</option>
                <option value="unrecognized">Unrecognized</option>
                <option value="general">General</option>
              </select>
            </label>
            <button className="submit full" type="submit" disabled={busy || !paymentId}>
              {busy ? "Opening…" : "Open dispute"}
            </button>
          </form>
          {error && <p className="alert alert-error">{error}</p>}
        </section>

        <section className="panel">
          <h2>All disputes ({disputes.length})</h2>
          {disputes.length === 0 ? (
            <p className="empty">No disputes yet.</p>
          ) : (
            <div className="product-list">
              {disputes.map((d) => (
                <article className="product-card" key={d.id}>
                  <div className="product-head">
                    <h3>{formatMoney(d.amount, "usd")}</h3>
                    <StatusBadge status={d.status} />
                  </div>
                  <p className="cust-sub">
                    {d.customerName} · {d.reason.replace(/_/g, " ")} · {d.paymentId}
                  </p>
                  <p className="cust-sub">Due {formatTimestamp(d.evidenceDueBy)}</p>
                  {d.status === "needs_response" && (
                    <div className="refund-actions">
                      <button className="chip" type="button" onClick={() => onEvidence(d.id)}>
                        Submit evidence
                      </button>
                      <button className="chip" type="button" onClick={() => onResolve(d.id, "won")}>
                        Mark won
                      </button>
                      <button className="chip" type="button" onClick={() => onResolve(d.id, "lost")}>
                        Mark lost
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
