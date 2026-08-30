import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPayment,
  fetchPayments,
  fetchStats,
  formatMoney,
  refundPayment,
  type Payment,
  type PaymentStats,
} from "./api.js";

const TEST_CARDS = [
  { label: "Visa — succeeds", value: "4242 4242 4242 4242" },
  { label: "Visa — declined", value: "4000 0000 0000 0002" },
  { label: "Visa — insufficient funds", value: "4000 0000 0000 9995" },
];

interface FormState {
  amount: string;
  currency: string;
  description: string;
  customerName: string;
  customerEmail: string;
  cardNumber: string;
}

const INITIAL_FORM: FormState = {
  amount: "25.00",
  currency: "usd",
  description: "Pro plan subscription",
  customerName: "Ada Lovelace",
  customerEmail: "ada@example.com",
  cardNumber: "4242 4242 4242 4242",
};

function StatusBadge({ status }: { status: Payment["status"] }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

export function App() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [stats, setStats] = useState<PaymentStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const [nextPayments, nextStats] = await Promise.all([fetchPayments(), fetchStats()]);
    setPayments(nextPayments);
    setStats(nextStats);
  }, []);

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [refresh]);

  const update = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const cents = Math.round(Number(form.amount) * 100);
      const payment = await createPayment({
        amount: cents,
        currency: form.currency,
        description: form.description,
        customerName: form.customerName,
        customerEmail: form.customerEmail,
        cardNumber: form.cardNumber,
      });
      if (payment.status === "declined") {
        setNotice(`Payment ${payment.id} was declined (${payment.failureReason}).`);
      } else {
        setNotice(`Payment ${payment.id} succeeded.`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onRefund = async (id: string) => {
    setError(null);
    setNotice(null);
    try {
      await refundPayment(id);
      setNotice(`Refunded ${id}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const currency = stats?.currency ?? "usd";
  const summaryCards = useMemo(
    () => [
      { label: "Net volume", value: formatMoney(stats?.netVolume ?? 0, currency) },
      { label: "Gross volume", value: formatMoney(stats?.grossVolume ?? 0, currency) },
      { label: "Payments", value: String(stats?.count ?? 0) },
      { label: "Declined", value: String(stats?.declinedCount ?? 0) },
    ],
    [stats, currency],
  );

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◈</span> cloud-pay
        </div>
        <span className="tagline">Payments dashboard</span>
      </header>

      <section className="summary">
        {summaryCards.map((card) => (
          <div className="summary-card" key={card.label}>
            <span className="summary-label">{card.label}</span>
            <span className="summary-value">{card.value}</span>
          </div>
        ))}
      </section>

      <div className="layout">
        <section className="panel">
          <h2>New payment</h2>
          <form onSubmit={onSubmit} className="form">
            <label>
              Amount
              <input value={form.amount} onChange={update("amount")} inputMode="decimal" required />
            </label>
            <label>
              Currency
              <input value={form.currency} onChange={update("currency")} maxLength={3} required />
            </label>
            <label className="full">
              Description
              <input value={form.description} onChange={update("description")} />
            </label>
            <label className="full">
              Customer name
              <input value={form.customerName} onChange={update("customerName")} required />
            </label>
            <label className="full">
              Customer email
              <input
                value={form.customerEmail}
                onChange={update("customerEmail")}
                type="email"
                required
              />
            </label>
            <label className="full">
              Card number
              <input value={form.cardNumber} onChange={update("cardNumber")} required />
            </label>
            <div className="test-cards full">
              {TEST_CARDS.map((c) => (
                <button
                  type="button"
                  key={c.value}
                  className="chip"
                  onClick={() => setForm((prev) => ({ ...prev, cardNumber: c.value }))}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <button className="submit full" type="submit" disabled={submitting}>
              {submitting ? "Processing…" : "Charge card"}
            </button>
          </form>
          {notice && <p className="alert alert-info">{notice}</p>}
          {error && <p className="alert alert-error">{error}</p>}
        </section>

        <section className="panel">
          <h2>Transactions</h2>
          {payments.length === 0 ? (
            <p className="empty">No payments yet. Charge a card to get started.</p>
          ) : (
            <table className="txns">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Amount</th>
                  <th>Card</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="cust-name">{p.customerName}</div>
                      <div className="cust-sub">{p.description || p.customerEmail}</div>
                    </td>
                    <td>{formatMoney(p.amount, p.currency)}</td>
                    <td className="mono">
                      {p.cardBrand} ···· {p.cardLast4}
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    <td>
                      {p.status === "succeeded" && (
                        <button className="refund" onClick={() => onRefund(p.id)}>
                          Refund
                        </button>
                      )}
                    </td>
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
