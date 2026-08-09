import { useEffect, useState } from "react";
import { addPrice, createProduct, fetchProducts, formatMoney, type Product } from "../api.js";

export function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceAmount, setPriceAmount] = useState("29.00");
  const [interval, setInterval] = useState<"one_time" | "month">("month");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    fetchProducts()
      .then((r) => setProducts(r.products))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

  useEffect(() => {
    load();
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const product = await createProduct({ name, description });
      const cents = Math.round(Number(priceAmount) * 100);
      await addPrice(product.id, {
        unitAmount: cents,
        currency: "usd",
        ...(interval === "month" ? { interval: "month", intervalCount: 1 } : {}),
      });
      setName("");
      setDescription("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-content">
      <header className="page-header">
        <h1>Products &amp; prices</h1>
        <p className="page-sub">Catalog of one-time and recurring offerings</p>
      </header>

      <div className="grid-2">
        <section className="panel">
          <h2>New product</h2>
          <form className="form form-single" onSubmit={onSubmit}>
            <label className="full">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="full">
              Description
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label>
              Price
              <input value={priceAmount} onChange={(e) => setPriceAmount(e.target.value)} inputMode="decimal" required />
            </label>
            <label>
              Billing
              <select value={interval} onChange={(e) => setInterval(e.target.value as "one_time" | "month")}>
                <option value="one_time">One-time</option>
                <option value="month">Monthly</option>
              </select>
            </label>
            <button className="submit full" type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create product"}
            </button>
          </form>
          {error && <p className="alert alert-error">{error}</p>}
        </section>

        <section className="panel">
          <h2>Catalog ({products.length})</h2>
          {products.length === 0 ? (
            <p className="empty">No products yet.</p>
          ) : (
            <div className="product-list">
              {products.map((p) => (
                <article className="product-card" key={p.id}>
                  <div className="product-head">
                    <h3>{p.name}</h3>
                    <span className={`badge ${p.active ? "badge-succeeded" : "badge-declined"}`}>
                      {p.active ? "active" : "inactive"}
                    </span>
                  </div>
                  <p className="cust-sub">{p.description || "No description"}</p>
                  <ul className="price-list">
                    {p.prices.map((price) => (
                      <li key={price.id}>
                        <span className="mono">{price.id}</span>
                        <span>
                          {formatMoney(price.unitAmount, price.currency)}
                          {price.interval ? ` / ${price.interval}` : " one-time"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
