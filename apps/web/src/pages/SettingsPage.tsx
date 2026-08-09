import { useCallback, useEffect, useState } from "react";
import {
  createApiKey,
  fetchApiKeys,
  formatTimestamp,
  revokeApiKey,
  type ApiKey,
} from "../api.js";
import { StatusBadge } from "../StatusBadge.js";

export function SettingsPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("Server integration");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setKeys(await fetchApiKeys());
  }, []);

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [refresh]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const key = await createApiKey(name);
      setSecret(key.secret ?? null);
      setNotice(`Created API key ${key.id}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRevoke = async (id: string) => {
    setError(null);
    try {
      await revokeApiKey(id);
      setNotice(`Revoked ${id}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="stack-layout">
      <section className="panel">
        <h2>API keys</h2>
        <p className="empty">
          Use <span className="mono">Authorization: Bearer cp_live_…</span> on API requests.
          Set <span className="mono">CLOUD_PAY_REQUIRE_AUTH=1</span> on the server to require keys.
        </p>
        <form className="form" onSubmit={onCreate}>
          <label className="full">
            Key name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <button className="submit full" type="submit">
            Create API key
          </button>
        </form>
        {secret && (
          <p className="alert alert-info">
            Secret (shown once): <span className="mono">{secret}</span>
          </p>
        )}
        {notice && <p className="alert alert-info">{notice}</p>}
        {error && <p className="alert alert-error">{error}</p>}

        {keys.length === 0 ? (
          <p className="empty">No API keys yet.</p>
        ) : (
          <table className="txns">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Status</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>
                    <div className="cust-name">{key.name}</div>
                    <div className="cust-sub mono">{key.id}</div>
                  </td>
                  <td className="mono">{key.prefix}…</td>
                  <td>
                    <StatusBadge status={key.revokedAt ? "canceled" : "succeeded"} />
                  </td>
                  <td className="cust-sub">
                    {key.lastUsedAt ? formatTimestamp(key.lastUsedAt) : "never"}
                  </td>
                  <td>
                    {!key.revokedAt && (
                      <button type="button" className="refund" onClick={() => void onRevoke(key.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Test cards</h2>
        <table className="txns">
          <thead>
            <tr>
              <th>Number</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">4242 4242 4242 4242</td>
              <td>Succeeds</td>
            </tr>
            <tr>
              <td className="mono">4000 0000 0000 0002</td>
              <td>Declined (card_declined)</td>
            </tr>
            <tr>
              <td className="mono">4000 0000 0000 9995</td>
              <td>Declined (insufficient_funds)</td>
            </tr>
            <tr>
              <td className="mono">4000 0000 0000 0069</td>
              <td>Declined (expired_card)</td>
            </tr>
            <tr>
              <td className="mono">4000 0000 0000 0119</td>
              <td>Declined (processing_error)</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
