import { useCallback, useEffect, useState } from "react";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  fetchWebhookDeliveries,
  fetchWebhookEndpoints,
  formatTimestamp,
  retryWebhookDelivery,
  updateWebhookEndpoint,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "../api.js";
import { StatusBadge } from "../StatusBadge.js";

export function WebhooksPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [url, setUrl] = useState("https://example.com/webhooks/cloud-pay");
  const [description, setDescription] = useState("My listener");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextEndpoints, nextDeliveries] = await Promise.all([
      fetchWebhookEndpoints(),
      fetchWebhookDeliveries(),
    ]);
    setEndpoints(nextEndpoints);
    setDeliveries(nextDeliveries);
  }, []);

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [refresh]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const endpoint = await createWebhookEndpoint({
        url,
        description,
        events: ["*"],
      });
      setCreatedSecret(endpoint.secret);
      setNotice(`Created endpoint ${endpoint.id}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggle = async (endpoint: WebhookEndpoint) => {
    setError(null);
    try {
      await updateWebhookEndpoint(endpoint.id, { enabled: !endpoint.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await deleteWebhookEndpoint(id);
      setNotice(`Deleted endpoint ${id}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const retry = async (id: string) => {
    setError(null);
    try {
      const delivery = await retryWebhookDelivery(id);
      setNotice(`Retry ${id} → ${delivery.status}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="stack-layout">
      <section className="panel">
        <h2>Webhook endpoints</h2>
        <form className="form" onSubmit={onCreate}>
          <label className="full">
            URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} required />
          </label>
          <label className="full">
            Description
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <button className="submit full" type="submit">
            Add endpoint
          </button>
        </form>
        {createdSecret && (
          <p className="alert alert-info">
            Signing secret (copy now): <span className="mono">{createdSecret}</span>
          </p>
        )}
        {notice && <p className="alert alert-info">{notice}</p>}
        {error && <p className="alert alert-error">{error}</p>}

        {endpoints.length === 0 ? (
          <p className="empty">No endpoints configured.</p>
        ) : (
          <table className="txns">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Events</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={endpoint.id}>
                  <td>
                    <div className="cust-name">{endpoint.description || endpoint.id}</div>
                    <div className="cust-sub mono">{endpoint.url}</div>
                    <div className="cust-sub mono">{endpoint.secret}</div>
                  </td>
                  <td className="mono">{endpoint.events.join(", ")}</td>
                  <td>
                    <StatusBadge status={endpoint.enabled ? "succeeded" : "canceled"} />
                  </td>
                  <td>
                    <div className="pager-buttons">
                      <button type="button" className="refund" onClick={() => void toggle(endpoint)}>
                        {endpoint.enabled ? "Disable" : "Enable"}
                      </button>
                      <button type="button" className="refund" onClick={() => void remove(endpoint.id)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Recent deliveries</h2>
        {deliveries.length === 0 ? (
          <p className="empty">No deliveries yet. Charge a payment to fan out events.</p>
        ) : (
          <table className="txns">
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div className="mono cust-name">{d.eventType}</div>
                    <div className="cust-sub mono">{d.id}</div>
                    {d.lastError && <div className="cust-sub">{d.lastError}</div>}
                  </td>
                  <td>
                    <StatusBadge
                      status={
                        d.status === "delivered"
                          ? "succeeded"
                          : d.status === "failed"
                            ? "declined"
                            : "requires_capture"
                      }
                    />
                  </td>
                  <td>
                    {d.attempts}
                    {d.responseStatus != null ? ` · HTTP ${d.responseStatus}` : ""}
                  </td>
                  <td className="cust-sub">{formatTimestamp(d.createdAt)}</td>
                  <td>
                    {d.status === "failed" && (
                      <button type="button" className="refund" onClick={() => void retry(d.id)}>
                        Retry
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
  );
}
