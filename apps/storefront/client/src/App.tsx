import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Placeholder from "./pages/Placeholder";

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
      <Route path="/login" element={<Placeholder />} />
      <Route path="/register" element={<Placeholder />} />
      <Route path="/forgot" element={<Placeholder />} />
      <Route path="/reset/:token" element={<Placeholder />} />

      <Route element={<Layout />}>
        <Route path="/" element={<Placeholder />} />
        <Route path="/c/:slug" element={<Placeholder />} />
        <Route path="/p/:slug" element={<Placeholder />} />
        <Route path="/search" element={<Placeholder />} />
        <Route path="/cart" element={<Placeholder />} />
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
            renders the error.njk visuals once ErrorPage lands with Cluster A. */}
        <Route path="*" element={<Placeholder />} />
      </Route>
    </Routes>
  );
}
