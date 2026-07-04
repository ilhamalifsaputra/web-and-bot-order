import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProductPage from "./ProductPage";
import { apiGet, apiPost } from "../api/client";
import type { ProductPageData, ShopContext } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
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
  tzname: "Asia/Jakarta",
};

const productData: ProductPageData = {
  product: {
    slug: "netflix-premium",
    name: "Netflix Premium",
    description: "Shared account, instant delivery.",
    category_name: "Streaming",
    category_slug: "streaming",
    image: "/img/netflix.jpg",
  },
  denominations: [
    {
      id: 1,
      name: "1 Month",
      duration_label: "1 Month",
      price: "79000",
      warranty_days: 7,
      available: 0,
      in_stock: false,
      bulk: null,
    },
    {
      id: 2,
      name: "3 Months",
      duration_label: "3 Months",
      price: "219000",
      warranty_days: 7,
      available: 3,
      in_stock: true,
      bulk: null,
    },
    {
      id: 3,
      name: "6 Months",
      duration_label: "6 Months",
      price: "399000",
      warranty_days: 14,
      available: 20,
      in_stock: true,
      bulk: null,
    },
  ],
  default_restock_denomination_id: 2,
  reviews: [
    { rating: 4.5, comment: "Great service!", author: "A***", created_at_display: "2026-06-01" },
  ],
  low_threshold: 5,
};

function renderProduct(slug: string, respond: (path: string) => unknown) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    return respond(path);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/p/${slug}`]}>
        <Routes>
          <Route path="/p/:slug" element={<ProductPage />} />
          <Route path="/cart" element={<div>cart-page-stub</div>} />
          <Route path="/checkout" element={<div>checkout-page-stub</div>} />
          <Route path="/login" element={<div>login-page-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProductPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("preselects the first in-stock denomination (skipping the out-of-stock one)", async () => {
    renderProduct("netflix-premium", () => productData);
    expect(await screen.findByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument();
    const radio3mo = screen.getByRole("radio", { name: /3 Months/ });
    expect(radio3mo).toBeChecked();
    const selectedPrice = document.querySelector(".font-display.font-semibold.text-pine.text-2xl");
    expect(selectedPrice).toHaveTextContent("Rp219.000");
    // In-stock plan selected -> buy form shown, not the restock CTA.
    expect(screen.getByRole("button", { name: /Add to cart/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Notify me when ready/ })).not.toBeInTheDocument();
    // Live-summary stock line is the njk inline script's `.chip` pill (not the
    // stock_badge macro's markup) — 3 Months has available=3 <= low_threshold=5.
    const chip = document.querySelector(".chip");
    expect(chip).toHaveClass("bg-amberx-tint", "text-amberx");
    expect(chip).toHaveTextContent("3 left");
  });

  it("selecting another in-stock denomination updates the displayed price, qty max, and stock chip", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const radio6mo = screen.getByRole("radio", { name: /6 Months/ });
    fireEvent.click(radio6mo);
    const selectedPrice = document.querySelector(".font-display.font-semibold.text-pine.text-2xl");
    await waitFor(() => expect(selectedPrice).toHaveTextContent("Rp399.000"));
    const qtyInput = screen.getByLabelText("Quantity") as HTMLInputElement;
    expect(qtyInput.max).toBe("20");
    // 6 Months has available=20 > low_threshold=5 -> "Available" / grass chip.
    const chip = document.querySelector(".chip");
    expect(chip).toHaveClass("bg-grass-tint", "text-grass-dark");
    expect(chip).toHaveTextContent("Available");
  });

  it("swaps to the restock CTA when selecting an out-of-stock denomination", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const radio1mo = screen.getByRole("radio", { name: /1 Month/ });
    fireEvent.click(radio1mo);
    // The 1-month plan is out of stock -> restock CTA replaces the buy form.
    expect(await screen.findByRole("button", { name: /Notify me when ready/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add to cart/ })).not.toBeInTheDocument();
    const chip = document.querySelector(".chip");
    expect(chip).toHaveClass("bg-rust-tint", "text-rust-dark");
    expect(chip).toHaveTextContent("Out of stock");
  });

  it("clamps typed qty to the selected denomination's available stock", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const qtyInput = screen.getByLabelText("Quantity") as HTMLInputElement;
    expect(qtyInput.max).toBe("3");
    fireEvent.change(qtyInput, { target: { value: "50" } });
    expect(qtyInput.value).toBe("3");
    fireEvent.change(qtyInput, { target: { value: "0" } });
    expect(qtyInput.value).toBe("1");
  });

  it("shows the restock CTA instead of the buy form for an out-of-stock-only product", async () => {
    const allOut: ProductPageData = {
      ...productData,
      denominations: productData.denominations.map((d) => ({ ...d, available: 0, in_stock: false })),
    };
    renderProduct("netflix-premium", () => allOut);
    expect(await screen.findByRole("button", { name: /Notify me when ready/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add to cart/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Buy now/ })).not.toBeInTheDocument();
  });

  it("renders reviews with masked author and the pre-formatted display date", async () => {
    renderProduct("netflix-premium", () => productData);
    expect(await screen.findByText(/A\*\*\* · 2026-06-01/)).toBeInTheDocument();
    expect(screen.getByText("Great service!")).toBeInTheDocument();
  });

  it("renders the no-reviews copy when there are none", async () => {
    renderProduct("netflix-premium", () => ({ ...productData, reviews: [] }));
    expect(await screen.findByText("No reviews yet.")).toBeInTheDocument();
  });

  it("renders the ErrorPage copy on a 404", async () => {
    renderProduct("does-not-exist", () => {
      const err = new Error("not_found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    expect(await screen.findByText("404")).toBeInTheDocument();
    expect(screen.getByText("That page doesn't exist.")).toBeInTheDocument();
  });

  it("adds to cart then navigates to /cart", async () => {
    (apiPost as Mock).mockResolvedValue({ items: [], subtotal: "0" });
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    fireEvent.click(screen.getByRole("button", { name: /Add to cart/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/cart", { denomination_id: 2, qty: 1 }));
    expect(await screen.findByText("cart-page-stub")).toBeInTheDocument();
  });
});
