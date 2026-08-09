import { useCallback, useEffect, useState } from "react";
import {
  cancelPayment,
  capturePayment,
  createDispute,
  fetchPayment,
  formatMoney,
  formatTimestamp,
  refundPayment,
  type DisputeReason,
  type PaymentDetail,
} from "./api.js";
import { StatusBadge } from "./StatusBadge.js";

interface PaymentDrawerProps {
  paymentId: string;
  onClose: () => void;
  onChanged: (message: string) => void;
}

const DISPUTE_REASONS: DisputeReason[] = [
  "fraudulent",
  "unrecognized",
  "duplicate",
  "product_not_received",
  "product_unacceptable",
  "subscription_canceled",
  "general",
];

function toCents(value: string): number {
  return Math.round(Number(value) * 100);
}

export function PaymentDrawer({ paymentId, onClose, onChanged }: PaymentDrawerProps) {
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [disputeReason, setDisputeReason] = useState<DisputeReason>("general");
  const [disputeEvidence, setDisputeEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await fetchPayment(paymentId);
    setDetail(next);
    if (next.amountRefundable > 0) {
      setAmount((next.amountRefundable / 100).toFixed(2));
    } else if (next.amountCapturable > 0) {
      setAmount((next.amountCapturable / 100).toFixed(2));
    }
  }, [paymentId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setReason("");
    setDisputeEvidence("");
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const run = async (action: () => Promise<string>) => {
    setError(null);
    setBusy(true);
    try {
      const message = await action();
      await load();
      onChanged(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRefund = (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    void run(async () => {
      const cents = toCents(amount);
      const updated = await refundPayment(detail.id, { amount: cents, reason });
      return `Refunded ${formatMoney(cents, updated.currency)} of ${detail.id} — now ${updated.status.replace(/_/g, " ")}.`;
    });
  };

  const onCapture = () => {
    if (!detail) return;
    void run(async () => {
      const cents = toCents(amount);
      const updated = await capturePayment(detail.id, cents);
      return `Captured ${formatMoney(cents, updated.currency)} for ${detail.id}.`;
    });
  };

  const onCancelAuth = () => {
    if (!detail) return;
    void run(async () => {
      await cancelPayment(detail.id);
      return `Canceled authorisation ${detail.id}.`;
    });
  };

  const onDispute = (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    void run(async () => {
      const dispute = await createDispute(detail.id, {
        reason: disputeReason,
        evidence: disputeEvidence,
      });
      return `Opened dispute ${dispute.id} on ${detail.id}.`;
    });
  };

  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <aside
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Payment details"
      >
        <header className="drawer-head">
          <span className="mono drawer-id">{paymentId}</span>
          <button className="icon-button" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </header>

        {!detail && !error && <p className="empty">Loading payment…</p>}
        {error && !detail && <p className="alert alert-error">{error}</p>}

        {detail && (
          <>
            <div className="drawer-amount">
              <span className="drawer-total">{formatMoney(detail.amount, detail.currency)}</span>
              <StatusBadge status={detail.status} />
            </div>

            <dl className="detail-grid">
              <div>
                <dt>Customer</dt>
                <dd>{detail.customerName}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{detail.customerEmail}</dd>
              </div>
              <div>
                <dt>Customer id</dt>
                <dd className="mono">{detail.customerId || "—"}</dd>
              </div>
              <div>
                <dt>Description</dt>
                <dd>{detail.description || "—"}</dd>
              </div>
              <div>
                <dt>Card</dt>
                <dd className="mono">
                  {detail.cardBrand} ···· {detail.cardLast4}
                </dd>
              </div>
              <div>
                <dt>Capture</dt>
                <dd>{detail.captureMethod}</dd>
              </div>
              <div>
                <dt>Refunded</dt>
                <dd>{formatMoney(detail.amountRefunded, detail.currency)}</dd>
              </div>
              <div>
                <dt>Refundable</dt>
                <dd>{formatMoney(detail.amountRefundable, detail.currency)}</dd>
              </div>
              <div>
                <dt>Capturable</dt>
                <dd>{formatMoney(detail.amountCapturable, detail.currency)}</dd>
              </div>
              <div>
                <dt>Statement</dt>
                <dd className="mono">{detail.statementDescriptor || "—"}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatTimestamp(detail.createdAt)}</dd>
              </div>
              {detail.failureReason && (
                <div>
                  <dt>Failure reason</dt>
                  <dd className="mono">{detail.failureReason}</dd>
                </div>
              )}
            </dl>

            {Object.keys(detail.metadata).length > 0 && (
              <section className="drawer-section">
                <h3>Metadata</h3>
                <dl className="meta-list">
                  {Object.entries(detail.metadata).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd className="mono">{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {detail.status === "requires_capture" && (
              <div className="refund-form">
                <h3>Capture authorisation</h3>
                <div className="refund-row">
                  <label>
                    Amount
                    <input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      inputMode="decimal"
                      required
                    />
                  </label>
                </div>
                <div className="refund-actions">
                  <button type="button" className="submit refund-submit" disabled={busy} onClick={onCapture}>
                    {busy ? "Working…" : "Capture"}
                  </button>
                  <button type="button" className="refund" disabled={busy} onClick={onCancelAuth}>
                    Cancel auth
                  </button>
                </div>
              </div>
            )}

            {detail.amountRefundable > 0 ? (
              <form className="refund-form" onSubmit={onRefund}>
                <h3>Issue a refund</h3>
                <div className="refund-row">
                  <label>
                    Amount
                    <input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      inputMode="decimal"
                      required
                    />
                  </label>
                  <label>
                    Reason
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="optional"
                    />
                  </label>
                </div>
                <div className="refund-actions">
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setAmount((detail.amountRefundable / 100).toFixed(2))}
                  >
                    Full remaining ({formatMoney(detail.amountRefundable, detail.currency)})
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setAmount((detail.amountRefundable / 200).toFixed(2))}
                  >
                    Half
                  </button>
                  <button className="submit refund-submit" type="submit" disabled={busy}>
                    {busy ? "Refunding…" : "Refund"}
                  </button>
                </div>
              </form>
            ) : (
              detail.status !== "requires_capture" && (
                <p className="empty refund-none">
                  {detail.status === "declined"
                    ? "Declined payments cannot be refunded."
                    : detail.status === "canceled"
                      ? "Canceled authorisations have no captured funds to refund."
                      : "This payment has been refunded in full."}
                </p>
              )
            )}

            {["succeeded", "partially_refunded"].includes(detail.status) && (
              <form className="refund-form" onSubmit={onDispute}>
                <h3>Open a dispute</h3>
                <div className="refund-row">
                  <label>
                    Reason
                    <select
                      value={disputeReason}
                      onChange={(e) => setDisputeReason(e.target.value as DisputeReason)}
                    >
                      {DISPUTE_REASONS.map((r) => (
                        <option key={r} value={r}>
                          {r.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Evidence
                    <input
                      value={disputeEvidence}
                      onChange={(e) => setDisputeEvidence(e.target.value)}
                      placeholder="optional notes"
                    />
                  </label>
                </div>
                <div className="refund-actions">
                  <button className="submit refund-submit" type="submit" disabled={busy}>
                    {busy ? "Opening…" : "Open dispute"}
                  </button>
                </div>
              </form>
            )}

            {error && <p className="alert alert-error">{error}</p>}

            {detail.refunds.length > 0 && (
              <section className="drawer-section">
                <h3>Refunds</h3>
                <ul className="refund-list">
                  {detail.refunds.map((r) => (
                    <li key={r.id}>
                      <span className="refund-amount">{formatMoney(r.amount, detail.currency)}</span>
                      <span className="refund-meta">
                        {r.reason || "no reason given"} · {formatTimestamp(r.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="drawer-section">
              <h3>Timeline</h3>
              <ol className="timeline">
                {detail.events.map((event) => (
                  <li key={event.id}>
                    <span className={`dot dot-${event.type.replace(/\./g, "-")}`} />
                    <div className="timeline-body">
                      <span className="timeline-type mono">{event.type}</span>
                      <span className="timeline-message">{event.message}</span>
                      <span className="timeline-time">{formatTimestamp(event.createdAt)}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </aside>
    </div>
  );
}
