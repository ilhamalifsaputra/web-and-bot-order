import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Placeholder from "./pages/Placeholder";
import ErrorPage from "./pages/ErrorPage";
import HomePage from "./pages/HomePage";
import CategoryPage from "./pages/CategoryPage";
import SearchPage from "./pages/SearchPage";
import ProductPage from "./pages/ProductPage";
import CartPage from "./pages/CartPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ForgotPage from "./pages/ForgotPage";
import ResetPage from "./pages/ResetPage";

/**
 * Full route table for every storefront URL. Pages start as <Placeholder /> and
 * are replaced cluster by cluster (docs/REACT_STOREFRONT_MIGRATION.md):
 * A catalog+cart, B auth, C checkout+pay, D account. Auth screens live outside
 * <Layout /> — login.njk & co render a full-viewport card without the shop
 * header/footer.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot" element={<ForgotPage />} />
      <Route path="/reset/:token" element={<ResetPage />} />

      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/c/:slug" element={<CategoryPage />} />
        <Route path="/p/:slug" element={<ProductPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/cart" element={<CartPage />} />
        <Route path="/checkout" element={<Placeholder />} />
        <Route path="/checkout/:code/pay" element={<Placeholder />} />
        <Route path="/account" element={<Placeholder />} />
        <Route path="/account/orders" element={<Placeholder />} />
        <Route path="/account/orders/:code" element={<Placeholder />} />
        <Route path="/account/referral" element={<Placeholder />} />
        <Route path="/account/reviews" element={<Placeholder />} />
        <Route path="/account/support" element={<Placeholder />} />
        <Route path="/account/support/:id" element={<Placeholder />} />
        <Route path="/account/settings" element={<Placeholder />} />
        {/* Unknown paths: the SPA shell already sent a real 404 status; this
            renders the error.njk visuals. */}
        <Route path="*" element={<ErrorPage />} />
      </Route>
    </Routes>
  );
}
