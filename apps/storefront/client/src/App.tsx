import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import RouteEffects from "./components/RouteEffects";
import RouteFallback from "./components/shop/RouteFallback";
import ErrorPage from "./pages/ErrorPage";
import HomePage from "./pages/HomePage";
import CategoryPage from "./pages/CategoryPage";
import CategoriesPage from "./pages/CategoriesPage";
import SearchPage from "./pages/SearchPage";
import ProductPage from "./pages/ProductPage";
import ProductsPage from "./pages/ProductsPage";
import FlashPage from "./pages/FlashPage";

// Code splitting, by who asks for the page.
//
// The catalog pages above (plus ErrorPage's catch-all, `*`, below) stay in
// the main bundle on purpose, not merely by omission: they're the routes a
// visitor can land on directly — a search result, a shared product link, a
// typo'd URL — and main.tsx removes the server-rendered #seo-shell the
// instant `createRoot(...).render()` returns. If one of these suspended on
// its own chunk during that *first* render, that removal would swap real,
// already-visible markup for this file's loading fallback — reintroducing
// the pre-hydration flash task 3 (836fe0d) fixed, just for a different
// reason. None of that applies once a visitor is already in the app: by the
// time they click into checkout or account, those chunks fetch in the
// background against a page that's already interactive.
//
// Everything below is reached only after a deliberate click (sign in, check
// out, open an order), by which time the chunk has long since been fetched in
// the background. Shipping them eagerly meant someone browsing a product page
// downloaded the entire checkout and account area — the bulk of a single
// 455 kB bundle — before anything appeared on screen.
const CartPage = lazy(() => import("./pages/CartPage"));
const CheckoutPage = lazy(() => import("./pages/CheckoutPage"));
const PayPage = lazy(() => import("./pages/PayPage"));
const WalletTopupPage = lazy(() => import("./pages/WalletTopupPage"));
// Guest order tracking — reached from a confirmation message or the sign-in
// page, never on the way to a purchase.
const TrackOrderPage = lazy(() => import("./pages/TrackOrderPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const RegisterPage = lazy(() => import("./pages/RegisterPage"));
const ForgotPage = lazy(() => import("./pages/ForgotPage"));
const ResetPage = lazy(() => import("./pages/ResetPage"));
const AccountPage = lazy(() => import("./pages/AccountPage"));
const OrdersPage = lazy(() => import("./pages/OrdersPage"));
const OrderDetailPage = lazy(() => import("./pages/OrderDetailPage"));
const ReferralPage = lazy(() => import("./pages/ReferralPage"));
const ReviewsPage = lazy(() => import("./pages/ReviewsPage"));
const SupportPage = lazy(() => import("./pages/SupportPage"));
const TicketDetailPage = lazy(() => import("./pages/TicketDetailPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
// Informational pages: read once, if ever, and never on the path to a
// purchase — they have no business in the catalog bundle.
const AboutPage = lazy(() => import("./pages/AboutPage"));
const HowToOrderPage = lazy(() => import("./pages/HowToOrderPage"));
const TermsPage = lazy(() => import("./pages/TermsPage"));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage"));
const RefundPage = lazy(() => import("./pages/RefundPage"));

/**
 * Full route table for every storefront URL. Ported cluster by cluster
 * (docs/REACT_STOREFRONT_MIGRATION.md): A catalog+cart, B auth, C
 * checkout+pay, D account — all four clusters are now real pages. Auth
 * screens live outside <Layout /> — login.njk & co render a full-viewport
 * card without the shop header/footer.
 */
export default function App() {
  return (
    // This boundary only ever fires for the four auth routes below — every
    // route inside <Layout/> has its own Suspense in PageTransition.tsx,
    // placed *inside* AnimatePresence's animated container so a suspending
    // page never blanks the header/footer chrome or breaks the transition
    // (see that file's comment). The auth routes render outside <Layout/>
    // with no chrome to preserve, so a plain top-level fallback is fine here.
    <Suspense fallback={<div className="min-h-[50vh] px-4 py-10"><RouteFallback /></div>}>
      {/* Sibling of <Routes>, not inside <Layout/>: covers every route,
          including the four auth screens below that sit outside it. See
          RouteEffects.tsx for what it does (title/scroll/focus on nav). */}
      <RouteEffects />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot" element={<ForgotPage />} />
        <Route path="/reset/:token" element={<ResetPage />} />

        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/c/:slug" element={<CategoryPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/flash" element={<FlashPage />} />
          <Route path="/p/:slug" element={<ProductPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/checkout/:code/pay" element={<PayPage />} />
          <Route path="/track" element={<TrackOrderPage />} />
          {/* Wallet top-up (Task 5): PayPage is reused as-is via `variant` —
              see PayPage.tsx's file header for why a fork wasn't needed. */}
          <Route path="/wallet/topup" element={<WalletTopupPage />} />
          <Route path="/wallet/topup/:code/pay" element={<PayPage variant="topup" />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/account/orders" element={<OrdersPage />} />
          <Route path="/account/orders/:code" element={<OrderDetailPage />} />
          <Route path="/account/referral" element={<ReferralPage />} />
          <Route path="/account/reviews" element={<ReviewsPage />} />
          <Route path="/account/support" element={<SupportPage />} />
          <Route path="/account/support/:id" element={<TicketDetailPage />} />
          <Route path="/account/settings" element={<SettingsPage />} />

          <Route path="/about" element={<AboutPage />} />
          <Route path="/how-to-order" element={<HowToOrderPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/refund" element={<RefundPage />} />
          {/* Unknown paths: the SPA shell already sent a real 404 status; this
            renders the error.njk visuals. */}
          <Route path="*" element={<ErrorPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
