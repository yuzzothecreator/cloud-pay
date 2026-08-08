import { useCallback, useEffect, useState } from "react";
import {
  fetchPayment,
  formatMoney,
  formatTimestamp,
  refundPayment,
  type PaymentDetail,
} from "./api.js";
import { StatusBadge } from "./StatusBadge.js";

interface PaymentDrawerProps {
  paymentId: string;
  onClose: () => void;
  onRefunded: (message: string) => void;
}

function toCents(value: string): number {
  return Math.round(Number(value) * 100);
}

export function PaymentDrawer({ paymentId, onClose, onRefunded }: PaymentDrawerProps) {
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await fetchPayment(paymentId);
    setDetail(next);
    setAmount((next.amountRefundable / 100).toFixed(2));
  }, [paymentId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setReason("");
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const onRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setError(null);
    setBusy(true);
    try {
      const cents = toCents(amount);
      const updated = await refundPayment(detail.id, { amount: cents, reason });
      await load();
      onRefunded(
        `Refunded ${formatMoney(cents, updated.currency)} of ${detail.id} — payment is now ${updated.status.replace(/_/g, " ")}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
                <dt>Refunded</dt>
                <dd>{formatMoney(detail.amountRefunded, detail.currency)}</dd>
              </div>
              <div>
                <dt>Refundable</dt>
                <dd>{formatMoney(detail.amountRefundable, detail.currency)}</dd>
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
              <p className="empty refund-none">
                {detail.status === "declined"
                  ? "Declined payments cannot be refunded."
                  : "This payment has been refunded in full."}
              </p>
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
