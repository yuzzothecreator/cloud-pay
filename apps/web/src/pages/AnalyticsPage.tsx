import { useEffect, useMemo, useState } from "react";
import { fetchAnalytics, formatMoney, type AnalyticsSnapshot } from "../api.js";
import { StatusBadge } from "../StatusBadge.js";

export function AnalyticsPage() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<AnalyticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAnalytics(days)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [days]);

  const maxNet = useMemo(
    () => Math.max(1, ...(data?.series.map((b) => b.net) ?? [1])),
    [data],
  );

  if (error) return <p className="alert alert-error">{error}</p>;
  if (!data) return <p className="empty">Loading analytics…</p>;

  const currency = data.currency;

  return (
    <div className="stack-layout">
      <section className="summary summary-6">
        <div className="summary-card">
          <span className="summary-label">Net ({days}d)</span>
          <span className="summary-value">{formatMoney(data.totals.net, currency)}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Gross</span>
          <span className="summary-value">{formatMoney(data.totals.volume, currency)}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Refunded</span>
          <span className="summary-value">{formatMoney(data.totals.refunded, currency)}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Payments</span>
          <span className="summary-value">{data.totals.count}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Customers</span>
          <span className="summary-value">{data.totals.customers}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Open disputes</span>
          <span className="summary-value">{data.totals.openDisputes}</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Daily net volume</h2>
          <div className="filters">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                type="button"
                className={`chip ${days === d ? "chip-active" : ""}`}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        <div className="chart" role="img" aria-label="Daily net volume chart">
          {data.series.map((bucket) => (
            <div className="chart-col" key={bucket.date} title={`${bucket.date}: ${formatMoney(bucket.net, currency)}`}>
              <div
                className="chart-bar"
                style={{ height: `${Math.max(4, (bucket.net / maxNet) * 140)}px` }}
              />
              <span className="chart-label">{bucket.date.slice(5)}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="layout">
        <section className="panel">
          <h2>Top customers</h2>
          {data.topCustomers.length === 0 ? (
            <p className="empty">No customer volume yet.</p>
          ) : (
            <ul className="refund-list">
              {data.topCustomers.map((c) => (
                <li key={c.id}>
                  <span>
                    <div className="cust-name">{c.name}</div>
                    <div className="cust-sub">{c.email}</div>
                  </span>
                  <span>
                    <div>{formatMoney(c.lifetimeValue, currency)}</div>
                    <div className="cust-sub">{c.paymentCount} payments</div>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Status breakdown</h2>
          {data.statusBreakdown.length === 0 ? (
            <p className="empty">No payments yet.</p>
          ) : (
            <ul className="refund-list">
              {data.statusBreakdown.map((row) => (
                <li key={row.status}>
                  <StatusBadge status={row.status} />
                  <span className="cust-name">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="empty" style={{ marginTop: 16 }}>
            Webhook failures: {data.totals.webhookFailures}
          </p>
        </section>
      </div>
    </div>
  );
}
