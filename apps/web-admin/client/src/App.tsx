import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { ForgotPage } from "./pages/ForgotPage";
import { ResetPage } from "./pages/ResetPage";
import { BootstrapPage } from "./pages/BootstrapPage";

// Code splitting, by who can land on the route directly.
//
// The five pages above stay in the main bundle on purpose, not merely by
// omission: DashboardPage is the `/` route — the first thing every admin
// session loads — and LoginPage/ForgotPage/ResetPage/BootstrapPage are
// unauthenticated entry points reached with no shell and no prior admin
// session to have warmed any other chunk. Everything below is reached only
// after a deliberate click from inside an already-authenticated, already-
// interactive shell (or, for the setup wizard, one step deep into a flow
// that starts at BootstrapPage), by which time there's no first-paint to
// protect. Shipping all 40 pages eagerly meant every admin — including one
// who only ever opens Orders — downloaded Reports/recharts, Broadcast,
// Audit, Settlements, Branding, Storage and the setup wizard before anything
// appeared on screen.
const CatalogPage = lazy(() => import("./pages/CatalogPage").then((m) => ({ default: m.CatalogPage })));
const DigiflazzSyncPage = lazy(() => import("./pages/DigiflazzSyncPage").then((m) => ({ default: m.DigiflazzSyncPage })));
const CategoriesPage = lazy(() => import("./pages/CategoriesPage").then((m) => ({ default: m.CategoriesPage })));
const ProductDetailPage = lazy(() => import("./pages/ProductDetailPage").then((m) => ({ default: m.ProductDetailPage })));
const ProductCreatePage = lazy(() => import("./pages/ProductCreatePage").then((m) => ({ default: m.ProductCreatePage })));
const DenominationCreatePage = lazy(() => import("./pages/DenominationCreatePage").then((m) => ({ default: m.DenominationCreatePage })));
const DenominationEditPage = lazy(() => import("./pages/DenominationEditPage").then((m) => ({ default: m.DenominationEditPage })));
const StockPage = lazy(() => import("./pages/StockPage").then((m) => ({ default: m.StockPage })));
const StockProductPage = lazy(() => import("./pages/StockProductPage").then((m) => ({ default: m.StockProductPage })));
const FlashSalesPage = lazy(() => import("./pages/FlashSalesPage").then((m) => ({ default: m.FlashSalesPage })));
const OrdersPage = lazy(() => import("./pages/OrdersPage").then((m) => ({ default: m.OrdersPage })));
const OrderDetailPage = lazy(() => import("./pages/OrderDetailPage").then((m) => ({ default: m.OrderDetailPage })));
const AuditPage = lazy(() => import("./pages/AuditPage").then((m) => ({ default: m.AuditPage })));
const OutboxPage = lazy(() => import("./pages/OutboxPage").then((m) => ({ default: m.OutboxPage })));
const ReportsPage = lazy(() => import("./pages/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const ReviewsPage = lazy(() => import("./pages/ReviewsPage").then((m) => ({ default: m.ReviewsPage })));
const SearchPage = lazy(() => import("./pages/SearchPage").then((m) => ({ default: m.SearchPage })));
const VouchersPage = lazy(() => import("./pages/VouchersPage").then((m) => ({ default: m.VouchersPage })));
const AdminsPage = lazy(() => import("./pages/AdminsPage").then((m) => ({ default: m.AdminsPage })));
const PaymentsPage = lazy(() => import("./pages/PaymentsPage").then((m) => ({ default: m.PaymentsPage })));
const WalletTransactionsPage = lazy(() => import("./pages/WalletTransactionsPage").then((m) => ({ default: m.WalletTransactionsPage })));
const SettlementsPage = lazy(() => import("./pages/SettlementsPage").then((m) => ({ default: m.SettlementsPage })));
const UsersPage = lazy(() => import("./pages/UsersPage").then((m) => ({ default: m.UsersPage })));
const UserDetailPage = lazy(() => import("./pages/UserDetailPage").then((m) => ({ default: m.UserDetailPage })));
const BroadcastPage = lazy(() => import("./pages/BroadcastPage").then((m) => ({ default: m.BroadcastPage })));
const SupportPage = lazy(() => import("./pages/SupportPage").then((m) => ({ default: m.SupportPage })));
const TicketDetailPage = lazy(() => import("./pages/TicketDetailPage").then((m) => ({ default: m.TicketDetailPage })));
const TasksPage = lazy(() => import("./pages/TasksPage").then((m) => ({ default: m.TasksPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const BrandingPage = lazy(() => import("./pages/BrandingPage").then((m) => ({ default: m.BrandingPage })));
const StoragePage = lazy(() => import("./pages/StoragePage").then((m) => ({ default: m.StoragePage })));
const SetupBotPage = lazy(() => import("./pages/SetupBotPage").then((m) => ({ default: m.SetupBotPage })));
const SetupOwnerPage = lazy(() => import("./pages/SetupOwnerPage").then((m) => ({ default: m.SetupOwnerPage })));
const SetupShopPage = lazy(() => import("./pages/SetupShopPage").then((m) => ({ default: m.SetupShopPage })));
const SetupDonePage = lazy(() => import("./pages/SetupDonePage").then((m) => ({ default: m.SetupDonePage })));

function NotFoundPage() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-ink-soft">Page not found.</p>
    </div>
  );
}

// Suspense fallback for a lazily-loaded route chunk — the moment between a
// route match and its JS finishing download, which is instant on a warm
// cache. Kept deliberately minimal, matching NotFoundPage's own bare style:
// this app has no existing loading/skeleton component shaped for a full
// page swap (SkeletonRow renders a <tr>, ProgressBar needs a value/tone),
// so inventing a whole component for a state this brief isn't worth it.
function RouteFallback() {
  return (
    <div className="flex flex-1 items-center justify-center" aria-busy="true">
      <p className="text-ink-soft">Loading…</p>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Authenticated shell — all pages that need sidebar + topbar */}
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/orders/:orderId" element={<OrderDetailPage />} />
          <Route path="/catalog" element={<CatalogPage />} />
          <Route path="/catalog/digiflazz-sync" element={<DigiflazzSyncPage />} />
          <Route path="/catalog/new" element={<ProductCreatePage />} />
          <Route path="/catalog/:productId/denominations/new" element={<DenominationCreatePage />} />
          <Route path="/catalog/:productId/denominations/:denomId/edit" element={<DenominationEditPage />} />
          <Route path="/catalog/:productId" element={<ProductDetailPage />} />
          {/* Deliberately not nested under /catalog: the sidebar's NavLink matches
              by prefix, so /catalog/categories would light up both entries. */}
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/stock" element={<StockPage />} />
          <Route path="/stock/:productId" element={<StockProductPage />} />
          <Route path="/flash-sales" element={<FlashSalesPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/users/:userId" element={<UserDetailPage />} />
          <Route path="/vouchers" element={<VouchersPage />} />
          <Route path="/admins" element={<AdminsPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/wallet-transactions" element={<WalletTransactionsPage />} />
          <Route path="/settlements" element={<SettlementsPage />} />
          <Route path="/outbox" element={<OutboxPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/reviews" element={<ReviewsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/broadcast" element={<BroadcastPage />} />
          <Route path="/support" element={<SupportPage />} />
          <Route path="/support/:ticketId" element={<TicketDetailPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/branding" element={<BrandingPage />} />
          <Route path="/storage" element={<StoragePage />} />
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
    </Suspense>
  );
}
