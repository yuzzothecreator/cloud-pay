import { useEffect, useState } from "react";
import { AnalyticsPage } from "./pages/AnalyticsPage.js";
import { CustomersPage } from "./pages/CustomersPage.js";
import { DisputesPage } from "./pages/DisputesPage.js";
import { PaymentsPage } from "./pages/PaymentsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { WebhooksPage } from "./pages/WebhooksPage.js";

type Page =
  | "payments"
  | "customers"
  | "disputes"
  | "webhooks"
  | "analytics"
  | "settings";

const NAV: Array<{ id: Page; label: string }> = [
  { id: "payments", label: "Payments" },
  { id: "customers", label: "Customers" },
  { id: "disputes", label: "Disputes" },
  { id: "webhooks", label: "Webhooks" },
  { id: "analytics", label: "Analytics" },
  { id: "settings", label: "Settings" },
];

function pageFromHash(): Page {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const match = NAV.find((item) => item.id === hash);
  return match?.id ?? "payments";
}

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) {
      window.location.hash = "#/payments";
    }
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (next: Page) => {
    window.location.hash = `#/${next}`;
    setPage(next);
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◈</span> cloud-pay
        </div>
        <span className="tagline">Payments platform</span>
      </header>

      <nav className="nav" aria-label="Primary">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-link ${page === item.id ? "nav-link-active" : ""}`}
            onClick={() => navigate(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {page === "payments" && <PaymentsPage />}
      {page === "customers" && <CustomersPage />}
      {page === "disputes" && <DisputesPage />}
      {page === "webhooks" && <WebhooksPage />}
      {page === "analytics" && <AnalyticsPage />}
      {page === "settings" && <SettingsPage />}
    </div>
  );
}
