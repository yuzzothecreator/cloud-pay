import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./Layout.js";
import { AnalyticsPage } from "./pages/AnalyticsPage.js";
import { CustomersPage } from "./pages/CustomersPage.js";
import { DisputesPage } from "./pages/DisputesPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { PaymentsPage } from "./pages/PaymentsPage.js";
import { PayoutsPage } from "./pages/PayoutsPage.js";
import { ProductsPage } from "./pages/ProductsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { SubscriptionsPage } from "./pages/SubscriptionsPage.js";
import { WebhooksPage } from "./pages/WebhooksPage.js";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<OverviewPage />} />
          <Route path="payments" element={<PaymentsPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="subscriptions" element={<SubscriptionsPage />} />
          <Route path="webhooks" element={<WebhooksPage />} />
          <Route path="disputes" element={<DisputesPage />} />
          <Route path="payouts" element={<PayoutsPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
