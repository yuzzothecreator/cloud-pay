import { useEffect, useState } from "react";
import {
  createPayout,
  fetchBalance,
  fetchPayouts,
  formatMoney,
  formatTimestamp,
  type Balance,
  type Payout,
} from "../api.js";
import { StatusBadge } from "../StatusBadge.js";

export function PayoutsPage() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [b, p] = await Promise.all([fetchBalance(), fetchPayouts()]);
    setBalance(b);
    setPayouts(p.payouts);
    if (!amount && b.available > 0) {
      setAmount((b.available / 100).toFixed(2));
    }
  };

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const cents = Math.round(Number(amount) * 100);
      await createPayout(cents);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const currency = balance?.currency ?? "usd";

  return (
    <div className="page-content">
      <header className="page-header">
        <h1>Payouts</h1>
        <p className="page-sub">Transfer available balance to your bank account</p>
      </header>

      <section className="summary summary-4">
        <div className="summary-card">
          <span className="summary-label">Available</span>
          <span className="summary-value">{formatMoney(balance?.available ?? 0, currency)}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Pending payouts</span>
          <span className="summary-value">{formatMoney(balance?.pending ?? 0, currency)}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Lifetime volume</span>
          <span className="summary-value">{formatMoney(balance?.lifetimeVolume ?? 0, currency)}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Lifetime fees</span>
          <span className="summary-value">{formatMoney(balance?.lifetimeFees ?? 0, currency)}</span>
        </div>
      </section>

      <div className="grid-2">
        <section className="panel">
          <h2>Request payout</h2>
          <form className="form form-single" onSubmit={onSubmit}>
            <label className="full">
              Amount
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
            </label>
            <button className="submit full" type="submit" disabled={busy || (balance?.available ?? 0) <= 0}>
              {busy ? "Requesting…" : "Request payout"}
            </button>
          </form>
          {error && <p className="alert alert-error">{error}</p>}
        </section>

        <section className="panel">
          <h2>Payout history</h2>
          {payouts.length === 0 ? (
            <p className="empty">No payouts yet. Process payments to build a balance.</p>
          ) : (
            <table className="txns">
              <thead>
                <tr>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Arrival</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.id}>
                    <td>{formatMoney(p.amount, p.currency)}</td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="cust-sub">{p.arrivalDate ? formatTimestamp(p.arrivalDate) : "—"}</td>
                    <td className="cust-sub">{formatTimestamp(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
