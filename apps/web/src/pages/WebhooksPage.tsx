import { useEffect, useState } from "react";
import {
  createWebhook,
  deleteWebhook,
  fetchWebhookDeliveries,
  fetchWebhooks,
  formatTimestamp,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "../api.js";

export function WebhooksPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [url, setUrl] = useState("https://example.com/webhooks/cloud-pay");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [wh, del] = await Promise.all([fetchWebhooks(), fetchWebhookDeliveries()]);
    setEndpoints(wh.endpoints);
    setDeliveries(del.deliveries);
  };

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createWebhook({ url, enabledEvents: ["*"] });
      setUrl("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    setError(null);
    try {
      await deleteWebhook(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page-content">
      <header className="page-header">
        <h1>Webhooks</h1>
        <p className="page-sub">Event delivery with retries and signing secrets</p>
      </header>

      <div className="grid-2">
        <section className="panel">
          <h2>Add endpoint</h2>
          <form className="form form-single" onSubmit={onSubmit}>
            <label className="full">
              URL
              <input value={url} onChange={(e) => setUrl(e.target.value)} type="url" required />
            </label>
            <button className="submit full" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Register endpoint"}
            </button>
          </form>
          {error && <p className="alert alert-error">{error}</p>}

          <h3 className="section-gap">Endpoints</h3>
          {endpoints.length === 0 ? (
            <p className="empty">No endpoints registered.</p>
          ) : (
            <ul className="endpoint-list">
              {endpoints.map((ep) => (
                <li key={ep.id}>
                  <div>
                    <div className="mono cust-name">{ep.url}</div>
                    <div className="cust-sub">Secret: {ep.secret.slice(0, 16)}…</div>
                  </div>
                  <button className="refund" type="button" onClick={() => onDelete(ep.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Recent deliveries ({deliveries.length})</h2>
          {deliveries.length === 0 ? (
            <p className="empty">Deliveries appear after payments, refunds, or subscriptions.</p>
          ) : (
            <table className="txns">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.eventType}</td>
                    <td>
                      <span className={`badge badge-${d.status}`}>
                        {d.status}
                      </span>
                    </td>
                    <td>{d.attempts}</td>
                    <td className="cust-sub">{formatTimestamp(d.createdAt)}</td>
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
