import { NavLink, Outlet } from "react-router-dom";

const NAV = [
  { to: "/", label: "Overview", icon: "◆" },
  { to: "/payments", label: "Payments", icon: "◇" },
  { to: "/customers", label: "Customers", icon: "◎" },
  { to: "/products", label: "Products", icon: "▣" },
  { to: "/subscriptions", label: "Subscriptions", icon: "↻" },
  { to: "/webhooks", label: "Webhooks", icon: "⇢" },
  { to: "/disputes", label: "Disputes", icon: "⚑" },
  { to: "/payouts", label: "Payouts", icon: "⇣" },
  { to: "/analytics", label: "Analytics", icon: "▤" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

export function Layout() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◈</span> cloud-pay
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => `nav-link ${isActive ? "nav-link-active" : ""}`}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
