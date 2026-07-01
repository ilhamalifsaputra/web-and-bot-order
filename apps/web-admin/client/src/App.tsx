import { Routes, Route } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { DashboardPage } from "./pages/DashboardPage";
import { CatalogPage } from "./pages/CatalogPage";
import { ProductDetailPage } from "./pages/ProductDetailPage";
import { ProductCreatePage } from "./pages/ProductCreatePage";
import { DenominationCreatePage } from "./pages/DenominationCreatePage";
import { StockPage } from "./pages/StockPage";
import { StockProductPage } from "./pages/StockProductPage";
import { OrdersPage } from "./pages/OrdersPage";
import { OrderDetailPage } from "./pages/OrderDetailPage";
import { AuditPage } from "./pages/AuditPage";
import { OutboxPage } from "./pages/OutboxPage";
import { ReportsPage } from "./pages/ReportsPage";
import { ReviewsPage } from "./pages/ReviewsPage";
import { SearchPage } from "./pages/SearchPage";
import { VouchersPage } from "./pages/VouchersPage";
import { AdminsPage } from "./pages/AdminsPage";
import { PaymentsPage } from "./pages/PaymentsPage";
import { UsersPage } from "./pages/UsersPage";
import { UserDetailPage } from "./pages/UserDetailPage";
import { BroadcastPage } from "./pages/BroadcastPage";
import { SupportPage } from "./pages/SupportPage";
import { TicketDetailPage } from "./pages/TicketDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { BrandingPage } from "./pages/BrandingPage";
import { LoginPage } from "./pages/LoginPage";
import { ForgotPage } from "./pages/ForgotPage";
import { ResetPage } from "./pages/ResetPage";
import { BootstrapPage } from "./pages/BootstrapPage";
import { SetupBotPage } from "./pages/SetupBotPage";
import { SetupOwnerPage } from "./pages/SetupOwnerPage";
import { SetupShopPage } from "./pages/SetupShopPage";
import { SetupDonePage } from "./pages/SetupDonePage";

function NotFoundPage() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-ink-soft">Page not found.</p>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Authenticated shell — all pages that need sidebar + topbar */}
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/orders/:orderId" element={<OrderDetailPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
        <Route path="/catalog/new" element={<ProductCreatePage />} />
        <Route path="/catalog/:productId/denominations/new" element={<DenominationCreatePage />} />
        <Route path="/catalog/:productId" element={<ProductDetailPage />} />
        <Route path="/stock" element={<StockPage />} />
        <Route path="/stock/:productId" element={<StockProductPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/users/:userId" element={<UserDetailPage />} />
        <Route path="/vouchers" element={<VouchersPage />} />
        <Route path="/admins" element={<AdminsPage />} />
        <Route path="/payments" element={<PaymentsPage />} />
        <Route path="/outbox" element={<OutboxPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/reviews" element={<ReviewsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/broadcast" element={<BroadcastPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/support/:ticketId" element={<TicketDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/branding" element={<BrandingPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>

      {/* Auth — no shell */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot" element={<ForgotPage />} />
      <Route path="/reset" element={<ResetPage />} />
      <Route path="/bootstrap" element={<BootstrapPage />} />

      {/* Setup wizard — no shell */}
      <Route path="/setup" element={<SetupBotPage />} />
      <Route path="/setup/owner" element={<SetupOwnerPage />} />
      <Route path="/setup/shop" element={<SetupShopPage />} />
      <Route path="/setup/done" element={<SetupDonePage />} />
    </Routes>
  );
}
