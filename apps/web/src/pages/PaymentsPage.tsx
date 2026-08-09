import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPayment,
  fetchPayments,
  fetchStats,
  formatMoney,
  type Payment,
  type PaymentStats,
} from "../api.js";
import { PaymentDrawer } from "../PaymentDrawer.js";
import { StatusBadge } from "../StatusBadge.js";

const PAGE_SIZE = 8;

const TEST_CARDS = [
  { label: "Visa — succeeds", value: "4242 4242 4242 4242" },
  { label: "Visa — declined", value: "4000 0000 0000 0002" },
  { label: "Visa — insufficient funds", value: "4000 0000 0000 9995" },
  { label: "Visa — processing error", value: "4000 0000 0000 0119" },
];

const STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "Succeeded", value: "succeeded" },
  { label: "Requires capture", value: "requires_capture" },
  { label: "Partially refunded", value: "partially_refunded" },
  { label: "Refunded", value: "refunded" },
  { label: "Declined", value: "declined" },
  { label: "Canceled", value: "canceled" },
];

interface FormState {
  amount: string;
  currency: string;
  description: string;
  customerName: string;
  customerEmail: string;
  cardNumber: string;
  captureMethod: "automatic" | "manual";
  statementDescriptor: string;
}

const INITIAL_FORM: FormState = {
  amount: "25.00",
  currency: "usd",
  description: "Pro plan subscription",
  customerName: "Ada Lovelace",
  customerEmail: "ada@example.com",
  cardNumber: "4242 4242 4242 4242",
  captureMethod: "automatic",
  statementDescriptor: "CLOUDPAY*PRO",
};

export function PaymentsPage() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<PaymentStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setOffset(0);
  }, [debouncedSearch, status]);

  const refresh = useCallback(async () => {
    const [page, nextStats] = await Promise.all([
      fetchPayments({ q: debouncedSearch, status, limit: PAGE_SIZE, offset }),
      fetchStats(),
    ]);
    if (page.total > 0 && page.offset >= page.total) {
      setOffset((Math.ceil(page.total / PAGE_SIZE) - 1) * PAGE_SIZE);
      return;
    }
    setPayments(page.payments);
    setTotal(page.total);
    setStats(nextStats);
  }, [debouncedSearch, status, offset]);

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [refresh]);

  const update = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
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
        captureMethod: form.captureMethod,
        statementDescriptor: form.statementDescriptor,
        metadata: { source: "dashboard" },
      });
      if (payment.status === "declined") {
        setNotice(`Payment ${payment.id} was declined (${payment.failureReason}).`);
      } else if (payment.status === "requires_capture") {
        setNotice(`Payment ${payment.id} authorised — capture when ready.`);
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

  const onChanged = async (message: string) => {
    setError(null);
    setNotice(message);
    await refresh().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  const currency = stats?.currency ?? "usd";
  const summaryCards = useMemo(
    () => [
      { label: "Net volume", value: formatMoney(stats?.netVolume ?? 0, currency) },
      { label: "Gross volume", value: formatMoney(stats?.grossVolume ?? 0, currency) },
      { label: "Refunded", value: formatMoney(stats?.refundedVolume ?? 0, currency) },
      { label: "Payments", value: String(stats?.count ?? 0) },
      {
        label: "Auth holds",
        value: String(stats?.requiresCaptureCount ?? 0),
      },
      { label: "Declined", value: String(stats?.declinedCount ?? 0) },
    ],
    [stats, currency],
  );

  const filtering = debouncedSearch !== "" || status !== "";
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <>
      <section className="summary summary-6">
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
            <label>
              Capture method
              <select value={form.captureMethod} onChange={update("captureMethod")}>
                <option value="automatic">Automatic</option>
                <option value="manual">Manual (auth only)</option>
              </select>
            </label>
            <label>
              Statement descriptor
              <input
                value={form.statementDescriptor}
                onChange={update("statementDescriptor")}
                maxLength={22}
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
              {submitting
                ? "Processing…"
                : form.captureMethod === "manual"
                  ? "Authorise card"
                  : "Charge card"}
            </button>
          </form>
          {notice && <p className="alert alert-info">{notice}</p>}
          {error && <p className="alert alert-error">{error}</p>}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Transactions</h2>
            <div className="panel-head-actions">
              <a className="refund" href="/api/payments/export.csv">
                Export CSV
              </a>
              <input
                className="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email, description or id"
                aria-label="Search transactions"
              />
            </div>
          </div>

          <div className="filters">
            {STATUS_FILTERS.map((filter) => (
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

          {payments.length === 0 ? (
            <p className="empty">
              {filtering
                ? "No payments match these filters."
                : "No payments yet. Charge a card to get started."}
            </p>
          ) : (
            <>
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
                    <tr key={p.id} className="txn-row" onClick={() => setSelectedId(p.id)}>
                      <td>
                        <div className="cust-name">{p.customerName}</div>
                        <div className="cust-sub">{p.description || p.customerEmail}</div>
                      </td>
                      <td>
                        <div>{formatMoney(p.amount, p.currency)}</div>
                        {p.amountRefunded > 0 && (
                          <div className="cust-sub">
                            −{formatMoney(p.amountRefunded, p.currency)} refunded
                          </div>
                        )}
                        {p.amountCapturable > 0 && (
                          <div className="cust-sub">
                            {formatMoney(p.amountCapturable, p.currency)} capturable
                          </div>
                        )}
                      </td>
                      <td className="mono">
                        {p.cardBrand} ···· {p.cardLast4}
                      </td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                      <td>
                        <button
                          className="refund"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(p.id);
                          }}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="pager">
                <span className="pager-range">
                  Showing {rangeStart}–{rangeEnd} of {total}
                </span>
                <div className="pager-buttons">
                  <button
                    className="refund"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    Previous
                  </button>
                  <button
                    className="refund"
                    disabled={offset + PAGE_SIZE >= total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {selectedId && (
        <PaymentDrawer
          paymentId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}
