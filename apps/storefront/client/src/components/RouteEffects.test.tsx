import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, Link, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RouteEffects from "./RouteEffects";
import { apiGet } from "../api/client";
import type { ShopContext } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
}));

const context: ShopContext = {
  lang: "en",
  fx: "16000",
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 0,
  customer: null,
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  wa_number: null,
  tzname: "Asia/Jakarta",
  currency: null,
};

/** Stand-in for Layout's <main> + PageTransition — a real navigation swaps
 * this per-page content while <main> itself stays put, the same shape
 * RouteEffects relies on for the focus move (see its module doc). */
function CartPage() {
  return (
    <main tabIndex={-1}>
      <h1>Cart</h1>
      <Link to="/checkout">Go to checkout</Link>
    </main>
  );
}

function CheckoutPage() {
  const navigate = useNavigate();
  return (
    <main tabIndex={-1}>
      <h1>Checkout</h1>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </main>
  );
}

function renderApp(initialEntries: string[] = ["/cart"]) {
  (apiGet as Mock).mockResolvedValue(context);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>
        <RouteEffects />
        <Routes>
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RouteEffects", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "";
    vi.clearAllMocks();
    // jsdom doesn't implement window.scrollTo — every test hits this effect
    // (whether or not it's the one under assertion), so stub it globally
    // rather than only in the two tests that assert on it.
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });

  it("sets document.title to match the route, in the same locale keys the server uses", async () => {
    renderApp(["/cart"]);
    await waitFor(() => expect(document.title).toBe("Cart — Toko Digital"));
  });

  it("updates document.title again after a client-side navigation", async () => {
    const user = userEvent.setup();
    renderApp(["/cart"]);
    await waitFor(() => expect(document.title).toBe("Cart — Toko Digital"));
    await user.click(screen.getByRole("link", { name: "Go to checkout" }));
    await waitFor(() => expect(document.title).toBe("Checkout — Toko Digital"));
  });

  it("scrolls to the top on a new (push) navigation", async () => {
    const scrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const user = userEvent.setup();
    renderApp(["/cart"]);
    await screen.findByText("Cart");
    scrollSpy.mockClear();
    await user.click(screen.getByRole("link", { name: "Go to checkout" }));
    await screen.findByText("Checkout");
    expect(scrollSpy).toHaveBeenCalledWith(0, 0);
  });

  it("does not scroll to the top on a back (pop) navigation", async () => {
    const scrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const user = userEvent.setup();
    renderApp(["/cart", "/checkout"]);
    await screen.findByText("Checkout");
    scrollSpy.mockClear();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText("Cart");
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does not steal focus on the initial page load", async () => {
    renderApp(["/cart"]);
    await screen.findByText("Cart");
    // jsdom defaults focus to <body> when nothing else has claimed it.
    expect(document.activeElement).toBe(document.body);
  });

  it("moves focus to <main> after a client-side navigation (T15)", async () => {
    const user = userEvent.setup();
    renderApp(["/cart"]);
    await screen.findByText("Cart");
    await user.click(screen.getByRole("link", { name: "Go to checkout" }));
    await screen.findByText("Checkout");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Checkout" }).closest("main")));
  });
});
