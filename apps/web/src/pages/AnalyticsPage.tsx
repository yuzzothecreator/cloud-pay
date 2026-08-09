import { useEffect, useState } from "react";
import { fetchAnalytics, formatMoney, type AnalyticsReport } from "../api.js";

export function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAnalytics(days)
      .then(setReport)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [days]);

  const maxGross = Math.max(...(report?.dailyVolume.map((d) => d.gross) ?? [1]), 1);

  return (
    <div className="page-content">
      <header className="page-header">
        <h1>Analytics</h1>
        <p className="page-sub">Revenue, subscriptions, and customer insights</p>
      </header>

      <div className="filters">
        {[7, 14, 30, 90].map((d) => (
          <button
            key={d}
            type="button"
            className={`chip ${days === d ? "chip-active" : ""}`}
            onClick={() => setDays(d)}
          >
            Last {d} days
          </button>
        ))}
      </div>

      {error && <p className="alert alert-error">{error}</p>}

      <section className="summary summary-4">
        <div className="summary-card">
          <span className="summary-label">MRR</span>
          <span className="summary-value">{formatMoney(report?.subscriptionMetrics.mrr ?? 0, "usd")}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Active subs</span>
          <span className="summary-value">{report?.subscriptionMetrics.active ?? 0}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Open disputes</span>
          <span className="summary-value">{report?.disputeMetrics.open ?? 0}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Dispute volume</span>
          <span className="summary-value">{formatMoney(report?.disputeMetrics.totalAmount ?? 0, "usd")}</span>
        </div>
      </section>

      <div className="grid-2">
        <section className="panel">
          <h2>Daily gross volume</h2>
          <div className="chart-bars chart-bars-tall">
            {(report?.dailyVolume ?? []).map((d) => (
              <div className="chart-bar-col" key={d.date}>
                <div
                  className="chart-bar"
                  style={{ height: `${Math.max(4, (d.gross / maxGross) * 100)}%` }}
                  title={formatMoney(d.gross, "usd")}
                />
                <span className="chart-label">{d.date.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Card brands</h2>
          <ul className="breakdown-list">
            {(report?.brandBreakdown ?? []).map((b) => (
              <li key={b.brand}>
                <span className="breakdown-label">{b.brand}</span>
                <span className="breakdown-value">
                  {b.count} txns · {formatMoney(b.volume, "usd")}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel full-span">
          <h2>Top customers</h2>
          <table className="txns">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Email</th>
                <th>Volume</th>
                <th>Payments</th>
              </tr>
            </thead>
            <tbody>
              {(report?.topCustomers ?? []).map((c, i) => (
                <tr key={c.customerId ?? i}>
                  <td>{c.name}</td>
                  <td>{c.email}</td>
                  <td>{formatMoney(c.volume, "usd")}</td>
                  <td>{c.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
