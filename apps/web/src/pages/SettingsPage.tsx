import { useEffect, useState } from "react";
import {
  createApiKey,
  fetchApiKeys,
  fetchSetup,
  getStoredApiKey,
  revokeApiKey,
  setStoredApiKey,
  type ApiKey,
} from "../api.js";

export function SettingsPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [apiKey, setApiKey] = useState(getStoredApiKey() ?? "");
  const [newKeyName, setNewKeyName] = useState("Dashboard key");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [setupKey, setSetupKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () =>
    fetchApiKeys()
      .then((r) => setKeys(r.keys))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

  useEffect(() => {
    load();
    fetchSetup()
      .then((s) => setSetupKey(s.apiKey))
      .catch(() => undefined);
  }, []);

  const saveKey = () => {
    setStoredApiKey(apiKey.trim());
    setNotice("API key saved to browser storage.");
    setError(null);
  };

  const useSetupKey = () => {
    if (setupKey) {
      setApiKey(setupKey);
      setStoredApiKey(setupKey);
      setNotice("Demo API key applied.");
    }
  };

  const onCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const created = await createApiKey(newKeyName);
      setRevealedKey(created.key);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRevoke = async (id: string) => {
    setError(null);
    try {
      await revokeApiKey(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page-content">
      <header className="page-header">
        <h1>Settings</h1>
        <p className="page-sub">API keys and authentication</p>
      </header>

      {notice && <p className="alert alert-info">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}

      <div className="grid-2">
        <section className="panel">
          <h2>Client API key</h2>
          <p className="cust-sub">
            Stored in localStorage and sent as <code className="mono">Authorization: Bearer …</code>
          </p>
          <label className="full block-label">
            API key
            <input
              className="search full-width"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="cpk_live_…"
            />
          </label>
          <div className="refund-actions">
            <button className="submit" type="button" onClick={saveKey}>
              Save key
            </button>
            {setupKey && (
              <button className="chip" type="button" onClick={useSetupKey}>
                Use server demo key
              </button>
            )}
          </div>
        </section>

        <section className="panel">
          <h2>Create API key</h2>
          <form className="form form-single" onSubmit={onCreateKey}>
            <label className="full">
              Name
              <input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} required />
            </label>
            <button className="submit full" type="submit">
              Generate key
            </button>
          </form>
          {revealedKey && (
            <p className="alert alert-info">
              New key (copy now — it won&apos;t be shown again):{" "}
              <code className="mono">{revealedKey}</code>
            </p>
          )}
        </section>

        <section className="panel full-span">
          <h2>Active keys</h2>
          {keys.length === 0 ? (
            <p className="empty">No API keys found.</p>
          ) : (
            <table className="txns">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="mono">{k.prefix}…</td>
                    <td className="cust-sub">{new Date(k.createdAt).toLocaleString()}</td>
                    <td className="cust-sub">
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "—"}
                    </td>
                    <td>
                      <button className="refund" type="button" onClick={() => onRevoke(k.id)}>
                        Revoke
                      </button>
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
