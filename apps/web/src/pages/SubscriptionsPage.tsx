import { useEffect, useState } from "react";
import {
  cancelSubscription,
  createSubscription,
  fetchCustomers,
  fetchProducts,
  fetchSubscriptions,
  formatMoney,
  formatTimestamp,
  type Customer,
  type Product,
  type Subscription,
} from "../api.js";
import { StatusBadge } from "../StatusBadge.js";

export function SubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [priceId, setPriceId] = useState("");
  const [cardNumber, setCardNumber] = useState("4242 4242 4242 4242");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [subs, custs, prods] = await Promise.all([
      fetchSubscriptions(),
      fetchCustomers(),
      fetchProducts(),
    ]);
    setSubscriptions(subs.subscriptions);
    setCustomers(custs.customers);
    setProducts(prods.products);
    if (!customerId && custs.customers[0]) setCustomerId(custs.customers[0].id);
    const recurring = prods.products.flatMap((p) => p.prices.filter((pr) => pr.interval));
    if (!priceId && recurring[0]) setPriceId(recurring[0].id);
  };

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const recurringPrices = products.flatMap((p) =>
    p.prices
      .filter((pr) => pr.interval)
      .map((pr) => ({ ...pr, productName: p.name })),
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createSubscription({ customerId, priceId, cardNumber });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async (id: string) => {
    setError(null);
    try {
      await cancelSubscription(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page-content">
      <header className="page-header">
        <h1>Subscriptions</h1>
        <p className="page-sub">Recurring billing with automatic renewals</p>
      </header>

      <div className="grid-2">
        <section className="panel">
          <h2>New subscription</h2>
          <form className="form form-single" onSubmit={onSubmit}>
            <label className="full">
              Customer
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.email})
                  </option>
                ))}
              </select>
            </label>
            <label className="full">
              Price
              <select value={priceId} onChange={(e) => setPriceId(e.target.value)} required>
                {recurringPrices.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.productName} — {formatMoney(pr.unitAmount, pr.currency)}/{pr.interval}
                  </option>
                ))}
              </select>
            </label>
            <label className="full">
              Card number
              <input value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} required />
            </label>
            <button className="submit full" type="submit" disabled={busy || !customerId || !priceId}>
              {busy ? "Creating…" : "Start subscription"}
            </button>
          </form>
          {error && <p className="alert alert-error">{error}</p>}
        </section>

        <section className="panel">
          <h2>Active subscriptions ({subscriptions.length})</h2>
          {subscriptions.length === 0 ? (
            <p className="empty">No subscriptions yet. Create a customer and recurring product first.</p>
          ) : (
            <div className="product-list">
              {subscriptions.map((s) => (
                <article className="product-card" key={s.id}>
                  <div className="product-head">
                    <h3>{s.productName}</h3>
                    <StatusBadge status={s.status} />
                  </div>
                  <p className="cust-sub">
                    {s.customerName} · {formatMoney(s.unitAmount, s.currency)}/{s.interval}
                  </p>
                  <p className="cust-sub">
                    Period ends {formatTimestamp(s.currentPeriodEnd)}
                    {s.cancelAtPeriodEnd ? " · cancels at period end" : ""}
                  </p>
                  {s.status !== "canceled" && !s.cancelAtPeriodEnd && (
                    <button className="refund" type="button" onClick={() => onCancel(s.id)}>
                      Cancel at period end
                    </button>
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
