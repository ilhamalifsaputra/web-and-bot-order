import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProductPage from "./ProductPage";
import { apiGet, apiPost } from "../api/client";
import type { ProductPageData, ShopContext } from "../api/types";
import type { ProductCardData } from "../components/shop/ProductCard";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

// jsdom has no IntersectionObserver (see HomePage.test.tsx's own note on this)
// and the detail/reviews/related-products sections now mount with Framer
// Motion's `whileInView`, which throws on mount without it — a no-op stub is
// enough since these tests don't assert scroll-triggered reveal behavior.
// The stub also records every observer with the elements it watches, because
// the sticky purchase bar keys off whether the buy card is on screen and jsdom
// computes no layout at all — the only way an observer can ever fire here is a
// test firing it (see `setBuyAreaOnScreen`). Not firing anything by default
// keeps the page in its initial state: buy card visible, no sticky bar.
type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
const observers: Array<{ callback: ObserverCallback; elements: Element[] }> = [];

class NoOpIntersectionObserver {
  private record: { callback: ObserverCallback; elements: Element[] };
  constructor(callback: ObserverCallback) {
    this.record = { callback, elements: [] };
    observers.push(this.record);
  }
  observe(element: Element) {
    this.record.elements.push(element);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
vi.stubGlobal("IntersectionObserver", NoOpIntersectionObserver);

/** Simulate the buy card scrolling in or out of the viewport. Only the
 * observer watching the buy card is fired, so Framer Motion's own
 * `whileInView` observers on this page are left alone. */
function setBuyAreaOnScreen(visible: boolean) {
  act(() => {
    for (const observer of observers) {
      if (observer.elements.some((element) => element.id === "buy-summary")) {
        observer.callback([{ isIntersecting: visible }]);
      }
    }
  });
}

/** The sticky bar is the only landmark on the page, so this is unambiguous. */
function stickyBar() {
  return screen.queryByRole("region");
}

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
    what_you_get: null,
    terms: null,
    warranty_note: null,
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
      delivery_type: "auto",
      additional_fields: [],
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
      delivery_type: "auto",
      additional_fields: [],
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
      delivery_type: "auto",
      additional_fields: [],
    },
  ],
  default_restock_denomination_id: 2,
  related_products: [],
  reviews: [
    { rating: 4.5, comment: "Great service!", author: "A***", created_at_display: "2026-06-01" },
  ],
  low_threshold: 5,
};

const relatedProduct: ProductCardData = {
  slug: "spotify-premium",
  name: "Spotify Premium",
  category_name: "Streaming",
  from_price: "45000",
  variant_count: 1,
  image: "/img/spotify.jpg",
  available: 10,
  rating: 4.8,
  rating_count: 5,
  bulk_discount: null,
  bulk_min_qty: null,
  all_non_auto: false,
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
    observers.length = 0;
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

  // STO-011: same-category "You might also like" shelf.
  it("renders the related-products shelf when the API returns some", async () => {
    renderProduct("netflix-premium", () => ({ ...productData, related_products: [relatedProduct] }));
    expect(await screen.findByText("You might also like")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Spotify Premium/ })).toHaveAttribute(
      "href",
      "/p/spotify-premium",
    );
  });

  it("omits the related-products shelf when the API returns none", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText("You might also like")).not.toBeInTheDocument();
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

  // Bug A regression (Task 6): a manual/manual_with_info denomination has no
  // stock rows by design (Task 2 skips stock reservation for non-auto
  // lines), so available=0/in_stock=false ALWAYS for these — the purchase
  // gate must key off delivery_type, not stock, or a manual-delivery product
  // could never be bought on the storefront.
  it("shows Buy Now / Add to cart (not the restock CTA) for a zero-stock manual denomination", async () => {
    const manualOnly: ProductPageData = {
      ...productData,
      denominations: [
        {
          id: 9,
          name: "Manual Plan",
          duration_label: "Manual Plan",
          price: "50000",
          warranty_days: 7,
          available: 0,
          in_stock: false,
          bulk: null,
          delivery_type: "manual",
          additional_fields: [],
        },
      ],
    };
    renderProduct("netflix-premium", () => manualOnly);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.getByRole("button", { name: /Add to cart/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Buy now/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Notify me when ready/ })).not.toBeInTheDocument();
  });

  // Bug B regression (Task 6): DenominationCard's radio used to be
  // disabled={!d.in_stock} — for a non-auto denomination that permanently
  // disabled selecting the plan at all, independent of the top-level
  // purchase-gate fix above.
  it("does not disable a zero-stock manual_with_info denomination's plan radio", async () => {
    const mixed: ProductPageData = {
      ...productData,
      denominations: [
        productData.denominations[1]!, // in-stock auto plan (preselected)
        {
          id: 9,
          name: "Manual Info Plan",
          duration_label: "Manual Info Plan",
          price: "50000",
          warranty_days: 7,
          available: 0,
          in_stock: false,
          bulk: null,
          delivery_type: "manual_with_info",
          additional_fields: [],
        },
      ],
    };
    renderProduct("netflix-premium", () => mixed);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const manualRadio = screen.getByRole("radio", { name: /Manual Info Plan/ }) as HTMLInputElement;
    expect(manualRadio).not.toBeDisabled();
    fireEvent.click(manualRadio);
    expect(manualRadio.checked).toBe(true);
    // Selecting it shows the buy form, not the restock CTA.
    expect(screen.getByRole("button", { name: /Add to cart/ })).toBeInTheDocument();
  });

  it("caps qty at 99 (not tied to stock) for a non-auto denomination", async () => {
    const manualOnly: ProductPageData = {
      ...productData,
      denominations: [
        {
          id: 9,
          name: "Manual Plan",
          duration_label: "Manual Plan",
          price: "50000",
          warranty_days: 7,
          available: 0,
          in_stock: false,
          bulk: null,
          delivery_type: "manual",
          additional_fields: [],
        },
      ],
    };
    renderProduct("netflix-premium", () => manualOnly);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const qtyInput = screen.getByLabelText("Quantity") as HTMLInputElement;
    expect(qtyInput.max).toBe("99");
    fireEvent.change(qtyInput, { target: { value: "150" } });
    expect(qtyInput.value).toBe("99");
  });

  // Flash sales: `price` on the denomination is ALREADY the sale price, so
  // the page adds the ⚡ badge, the struck-through `flash.base_price`, and a
  // countdown that reads in hours/days, not bare mm:ss.
  it("shows the flash badge, struck-through base price and countdown for a discounted denomination", async () => {
    // 26h + a minute of slack: the countdown floors, so a flat 26h would tick
    // down to "1d 1h" between the fixture being built and the assertion.
    const endsAt = new Date(Date.now() + 26 * 3600 * 1000 + 60_000).toISOString();
    const onSale: ProductPageData = {
      ...productData,
      denominations: [
        {
          ...productData.denominations[1]!,
          price: "175200",
          flash: { discount_percent: "20", base_price: "219000", ends_at: endsAt },
        },
      ],
    };
    renderProduct("netflix-premium", () => onSale);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const selectedPrice = document.querySelector(".font-display.font-semibold.text-pine.text-2xl");
    expect(selectedPrice).toHaveTextContent("Rp175.200");
    // One badge on the plan card, one in the live summary.
    expect(screen.getAllByText(/Flash sale/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Flash sale/)[0]).toHaveTextContent("20%");
    expect(screen.getAllByText("Was Rp219.000").length).toBeGreaterThan(0);
    // 26h left -> days/hours wording, never a mm:ss clock.
    expect(screen.getByText(/Ends in/)).toHaveTextContent("1d 2h");
  });

  it("shows no flash badge, struck-through price or countdown when no sale is running", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText(/Flash sale/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Was /)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ends in/)).not.toBeInTheDocument();
  });

  it("does not show a false out-of-stock indicator for a non-auto denomination", async () => {
    const manualOnly: ProductPageData = {
      ...productData,
      denominations: [
        {
          id: 9,
          name: "Manual Plan",
          duration_label: "Manual Plan",
          price: "50000",
          warranty_days: 7,
          available: 0,
          in_stock: false,
          bulk: null,
          delivery_type: "manual",
          additional_fields: [],
        },
      ],
    };
    renderProduct("netflix-premium", () => manualOnly);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText("Out of stock")).not.toBeInTheDocument();
  });
});

// Sticky mobile purchase bar. `useIsDesktop()` reports false under jsdom
// (no matchMedia -> mobile-first), so the mobile branch is what renders here.
describe("ProductPage sticky purchase bar", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    observers.length = 0;
    vi.clearAllMocks();
  });

  it("stays hidden while the in-page buy controls are on screen", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(stickyBar()).not.toBeInTheDocument();
  });

  it("appears once the buy controls scroll out of view, showing the selected plan and price", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    setBuyAreaOnScreen(false);
    const bar = stickyBar();
    expect(bar).toBeInTheDocument();
    // Preselected plan is the first in-stock one, 3 Months at Rp219.000.
    expect(within(bar!).getByText("3 Months")).toBeInTheDocument();
    expect(within(bar!).getByText("Rp219.000")).toBeInTheDocument();
    expect(within(bar!).getByRole("button", { name: /Buy now/ })).toBeInTheDocument();
    // Scrolling back to the buy card retires it again.
    setBuyAreaOnScreen(true);
    expect(stickyBar()).not.toBeInTheDocument();
  });

  it("tracks the plan the shopper selects", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    fireEvent.click(screen.getByRole("radio", { name: /6 Months/ }));
    setBuyAreaOnScreen(false);
    const bar = stickyBar();
    expect(within(bar!).getByText("6 Months")).toBeInTheDocument();
    expect(within(bar!).getByText("Rp399.000")).toBeInTheDocument();
  });

  it("buys through the same mutation as the in-page button, with the current qty", async () => {
    (apiPost as Mock).mockResolvedValue({ items: [], subtotal: "0" });
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } });
    setBuyAreaOnScreen(false);
    fireEvent.click(within(stickyBar()!).getByRole("button", { name: /Buy now/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/cart", { denomination_id: 2, qty: 2 }));
    expect(await screen.findByText("checkout-page-stub")).toBeInTheDocument();
  });

  it("offers the restock CTA instead of Buy now when nothing is purchasable", async () => {
    const allOut: ProductPageData = {
      ...productData,
      denominations: productData.denominations.map((d) => ({ ...d, available: 0, in_stock: false })),
    };
    renderProduct("netflix-premium", () => allOut);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    setBuyAreaOnScreen(false);
    const bar = stickyBar();
    expect(within(bar!).getByRole("button", { name: /Notify me when ready/ })).toBeInTheDocument();
    expect(within(bar!).queryByRole("button", { name: /Buy now/ })).not.toBeInTheDocument();
  });
});

describe("ProductPage sharing and image formats", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    observers.length = 0;
    vi.clearAllMocks();
  });

  it("offers WhatsApp, Telegram and X share links carrying the product URL", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });

    const whatsapp = screen.getByRole("link", { name: /Share on WhatsApp/i });
    const telegram = screen.getByRole("link", { name: /Share on Telegram/i });
    const x = screen.getByRole("link", { name: /Share on X/i });

    expect(whatsapp.getAttribute("href")).toContain("api.whatsapp.com");
    // The product name rides along, encoded.
    expect(whatsapp.getAttribute("href")).toContain(encodeURIComponent("Netflix Premium"));
    expect(telegram.getAttribute("href")).toContain("t.me/share/url");
    expect(x.getAttribute("href")).toContain("twitter.com/intent/tweet");

    // Opening a share target must not hand the shop's tab to the other site.
    for (const link of [whatsapp, telegram, x]) {
      expect(link.getAttribute("rel")).toContain("noopener");
      expect(link.getAttribute("target")).toBe("_blank");
    }
  });

  it("renders only the detail blocks the admin actually filled in", async () => {
    const withDetails: ProductPageData = {
      ...productData,
      product: {
        ...productData.product,
        what_you_get: "Private account, 1 device",
        terms: null,
        warranty_note: "Full 30-day warranty.",
      },
    };
    renderProduct("netflix-premium", () => withDetails);
    expect(await screen.findByText("Private account, 1 device")).toBeInTheDocument();
    expect(screen.getByText("Full 30-day warranty.")).toBeInTheDocument();
    // `terms` is empty, so its heading must not dangle over nothing.
    expect(screen.queryByRole("heading", { name: "Terms of use" })).not.toBeInTheDocument();
  });

  it("shows no detail section at all when all three blocks are empty", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByText("Shared account, instant delivery.");
    expect(screen.queryByRole("heading", { name: "What you get" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Warranty" })).not.toBeInTheDocument();
  });

  it("renders a plain <img> when the image has no WebP derivatives", async () => {
    renderProduct("netflix-premium", () => productData);
    const img = await screen.findByAltText("Netflix Premium");
    expect(img.tagName).toBe("IMG");
    expect(img.parentElement?.querySelector("source")).toBeNull();
  });

  // The hero image is the LCP element: it must not be deferred, and it must
  // declare its intrinsic size so the page doesn't jump as it decodes.
  it("loads the hero image eagerly with intrinsic dimensions", async () => {
    renderProduct("netflix-premium", () => productData);
    const img = await screen.findByAltText("Netflix Premium");
    expect(img).toHaveAttribute("loading", "eager");
    expect(img).toHaveAttribute("width", "800");
    expect(img).toHaveAttribute("height", "600");
  });

  it("asks phones for the numeric keypad on the qty field", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.getByLabelText("Quantity")).toHaveAttribute("inputmode", "numeric");
  });

  it("offers the WebP derivatives as a <source> when they exist", async () => {
    const withSrcset: ProductPageData = {
      ...productData,
      product: {
        ...productData.product,
        image: "/uploads/products/product-abc.jpg",
        image_srcset:
          "/uploads/products/product-abc-400.webp 400w, /uploads/products/product-abc-800.webp 800w",
      },
    };
    renderProduct("netflix-premium", () => withSrcset);
    const img = await screen.findByAltText("Netflix Premium");
    const source = img.parentElement?.querySelector("source");
    expect(source).not.toBeNull();
    expect(source?.getAttribute("type")).toBe("image/webp");
    expect(source?.getAttribute("srcset")).toContain("product-abc-800.webp 800w");
    // The original stays the fallback, so a browser without WebP still works.
    expect(img.getAttribute("src")).toBe("/uploads/products/product-abc.jpg");
  });
});
