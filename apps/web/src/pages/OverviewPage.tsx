import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchAnalytics,
  fetchBalance,
  fetchDisputes,
  fetchPayments,
  fetchStats,
  fetchSubscriptions,
  formatMoney,
  type AnalyticsReport,
  type Balance,
  type PaymentStats,
} from "../api.js";

export function OverviewPage() {
  const [stats, setStats] = useState<PaymentStats | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsReport | null>(null);
  const [recentCount, setRecentCount] = useState(0);
  const [openDisputes, setOpenDisputes] = useState(0);
  const [activeSubs, setActiveSubs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchStats(),
      fetchBalance(),
      fetchAnalytics(14),
      fetchPayments({ limit: 5 }),
      fetchDisputes(),
      fetchSubscriptions(),
    ])
      .then(([s, b, a, p, d, subs]) => {
        setStats(s);
        setBalance(b);
        setAnalytics(a);
        setRecentCount(p.total);
        setOpenDisputes(d.disputes.filter((x: { status: string }) => x.status === "needs_response").length);
        setActiveSubs(subs.subscriptions.filter((x: { status: string }) => x.status === "active").length);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const currency = stats?.currency ?? "usd";
  const cards = useMemo(
    () => [
      { label: "Net volume", value: formatMoney(stats?.netVolume ?? 0, currency), link: "/analytics" },
      { label: "Available balance", value: formatMoney(balance?.available ?? 0, currency), link: "/payouts" },
      { label: "MRR", value: formatMoney(analytics?.subscriptionMetrics.mrr ?? 0, currency), link: "/subscriptions" },
      { label: "Payments", value: String(stats?.count ?? 0), link: "/payments" },
      { label: "Active subs", value: String(activeSubs), link: "/subscriptions" },
      { label: "Open disputes", value: String(openDisputes), link: "/disputes" },
    ],
    [stats, balance, analytics, activeSubs, openDisputes, currency],
  );

  const maxGross = Math.max(...(analytics?.dailyVolume.map((d: { gross: number }) => d.gross) ?? [1]), 1);

  return (
    <div className="page-content">
      <header className="page-header">
        <h1>Overview</h1>
        <p className="page-sub">Payments platform dashboard — {recentCount} total transactions</p>
      </header>

      {error && <p className="alert alert-error">{error}</p>}

      <section className="summary">
        {cards.map((card) => (
          <Link to={card.link} className="summary-card summary-card-link" key={card.label}>
            <span className="summary-label">{card.label}</span>
            <span className="summary-value">{card.value}</span>
          </Link>
        ))}
      </section>

      <div className="grid-2">
        <section className="panel">
          <h2>Volume (14 days)</h2>
          <div className="chart-bars">
            {(analytics?.dailyVolume ?? []).map((d: { date: string; gross: number }) => (
              <div className="chart-bar-col" key={d.date} title={`${d.date}: ${formatMoney(d.gross, currency)}`}>
                <div
                  className="chart-bar"
                  style={{ height: `${Math.max(4, (d.gross / maxGross) * 100)}%` }}
                />
                <span className="chart-label">{d.date.slice(5)}</span>
              </div>
            ))}
            {(analytics?.dailyVolume.length ?? 0) === 0 && (
              <p className="empty">No volume data yet.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <h2>Status breakdown</h2>
          <ul className="breakdown-list">
            {(analytics?.statusBreakdown ?? []).map((s: { status: string; count: number; volume: number }) => (
              <li key={s.status}>
                <span className="breakdown-label">{s.status.replace(/_/g, " ")}</span>
                <span className="breakdown-value">
                  {s.count} · {formatMoney(s.volume, currency)}
                </span>
              </li>
            ))}
            {(analytics?.statusBreakdown.length ?? 0) === 0 && (
              <p className="empty">No payments recorded yet.</p>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
