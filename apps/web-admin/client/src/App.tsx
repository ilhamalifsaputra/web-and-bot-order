import { Routes, Route } from "react-router-dom";
import { CatalogPage } from "./pages/CatalogPage";
import { ProductDetailPage } from "./pages/ProductDetailPage";
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
import { QuickActionsBar } from "./components/dashboard/QuickActionsBar";
import { KpiRow } from "./components/dashboard/KpiRow";
import { OperationCenter } from "./components/dashboard/OperationCenter";
import { InventoryMonitoringCard } from "./components/dashboard/InventoryMonitoringCard";
import { ExpirationsTable } from "./components/dashboard/ExpirationsTable";
import { SalesAnalyticsCard } from "./components/dashboard/SalesAnalyticsCard";
import { RecentOrdersTable } from "./components/dashboard/RecentOrdersTable";
import { BusinessHealthGrid } from "./components/dashboard/BusinessHealthGrid";
import { TopProductsList } from "./components/dashboard/TopProductsList";

function Dashboard() {
  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-10 flex flex-col gap-3 border-b border-line bg-paper/90 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Shop Admin</h1>
        <QuickActionsBar />
      </header>
      <main className="flex flex-col gap-6 p-4 sm:p-6">
        <KpiRow />
        <OperationCenter />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <InventoryMonitoringCard />
          <ExpirationsTable />
        </div>
        <SalesAnalyticsCard />
        <RecentOrdersTable />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <BusinessHealthGrid />
          <TopProductsList />
        </div>
      </main>
    </div>
  );
}

function ComingSoon({ page }: { page: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper">
      <p className="text-ink-soft">{page} — migrating to React…</p>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/orders" element={<OrdersPage />} />
      <Route path="/orders/:orderId" element={<OrderDetailPage />} />
      <Route path="/catalog" element={<CatalogPage />} />
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
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot" element={<ForgotPage />} />
      <Route path="/reset" element={<ResetPage />} />
      <Route path="/bootstrap" element={<BootstrapPage />} />
      <Route path="/setup" element={<SetupBotPage />} />
      <Route path="/setup/owner" element={<SetupOwnerPage />} />
      <Route path="/setup/shop" element={<SetupShopPage />} />
      <Route path="/setup/done" element={<SetupDonePage />} />
      <Route path="*" element={<ComingSoon page="Page not found" />} />
    </Routes>
  );
}
