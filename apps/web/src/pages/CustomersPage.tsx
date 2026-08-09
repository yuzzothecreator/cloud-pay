import { useEffect, useState } from "react";
import { createCustomer, fetchCustomers, formatMoney, formatTimestamp, type Customer } from "../api.js";

export function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    fetchCustomers()
      .then((r) => setCustomers(r.customers))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

  useEffect(() => {
    load();
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createCustomer({ name, email, phone });
      setName("");
      setEmail("");
      setPhone("");
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
        <h1>Customers</h1>
        <p className="page-sub">Manage customer records and lifetime value</p>
      </header>

      <div className="grid-2">
        <section className="panel">
          <h2>Add customer</h2>
          <form className="form form-single" onSubmit={onSubmit}>
            <label className="full">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="full">
              Email
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
            </label>
            <label className="full">
              Phone
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <button className="submit full" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Create customer"}
            </button>
          </form>
          {error && <p className="alert alert-error">{error}</p>}
        </section>

        <section className="panel">
          <h2>All customers ({customers.length})</h2>
          {customers.length === 0 ? (
            <p className="empty">No customers yet.</p>
          ) : (
            <table className="txns">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Spent</th>
                  <th>Payments</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="cust-name">{c.name}</div>
                      <div className="cust-sub mono">{c.id}</div>
                    </td>
                    <td>{c.email}</td>
                    <td>{formatMoney(c.totalSpent, "usd")}</td>
                    <td>{c.paymentCount}</td>
                    <td className="cust-sub">{formatTimestamp(c.createdAt)}</td>
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
