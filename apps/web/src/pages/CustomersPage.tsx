import { useCallback, useEffect, useState } from "react";
import {
  fetchCustomers,
  fetchPayments,
  formatMoney,
  formatTimestamp,
  upsertCustomer,
  type Customer,
  type Payment,
} from "../api.js";
import { StatusBadge } from "../StatusBadge.js";

export function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<Customer | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
  });

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const refresh = useCallback(async () => {
    const page = await fetchCustomers({ q: debounced, limit: 50, offset: 0 });
    setCustomers(page.customers);
    setTotal(page.total);
  }, [debounced]);

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [refresh]);

  const openCustomer = async (customer: Customer) => {
    setSelected(customer);
    setError(null);
    try {
      const page = await fetchPayments({ customerId: customer.id, limit: 20, offset: 0 });
      setPayments(page.payments);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const customer = await upsertCustomer(form);
      setNotice(`Saved customer ${customer.id}`);
      setForm({ name: "", email: "", phone: "" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="layout">
      <section className="panel">
        <h2>Add / update customer</h2>
        <form className="form" onSubmit={onCreate}>
          <label className="full">
            Name
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </label>
          <label className="full">
            Email
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              required
            />
          </label>
          <label className="full">
            Phone
            <input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </label>
          <button className="submit full" type="submit">
            Save customer
          </button>
        </form>
        {notice && <p className="alert alert-info">{notice}</p>}
        {error && <p className="alert alert-error">{error}</p>}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Customers ({total})</h2>
          <input
            className="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers"
            aria-label="Search customers"
          />
        </div>

        {customers.length === 0 ? (
          <p className="empty">No customers yet.</p>
        ) : (
          <table className="txns">
            <thead>
              <tr>
                <th>Name</th>
                <th>Lifetime value</th>
                <th>Payments</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="txn-row" onClick={() => void openCustomer(c)}>
                  <td>
                    <div className="cust-name">{c.name}</div>
                    <div className="cust-sub">{c.email}</div>
                  </td>
                  <td>{formatMoney(c.lifetimeValue, "usd")}</td>
                  <td>{c.paymentCount}</td>
                  <td>
                    <button className="refund" type="button">
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {selected && (
          <div className="drawer-section">
            <h3>
              {selected.name}{" "}
              <span className="mono cust-sub">{selected.id}</span>
            </h3>
            <p className="empty">
              {selected.phone || "No phone"} · joined {formatTimestamp(selected.createdAt)}
            </p>
            {payments.length === 0 ? (
              <p className="empty">No payments for this customer.</p>
            ) : (
              <ul className="refund-list">
                {payments.map((p) => (
                  <li key={p.id}>
                    <span>
                      {formatMoney(p.amount, p.currency)} · {p.description || p.id}
                    </span>
                    <StatusBadge status={p.status} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
