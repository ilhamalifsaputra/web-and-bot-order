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
  wa_number: null,
  tzname: "Asia/Jakarta",
  currency: null,
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
    rating: 4.6,
    rating_count: 12,
    checkout_flow: "catalog",
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

function renderProduct(slug: string, respond: (path: string) => unknown, ctx: ShopContext = context) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return ctx;
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
    document.title = "";
    observers.length = 0;
    vi.clearAllMocks();
  });

  // T2: the product name isn't known until the fetch resolves, so this page
  // sets document.title itself rather than relying on routeTitle.ts's
  // pathname-only mapping (which deliberately skips /p/:slug).
  it("sets document.title to the product name once it loads (T2)", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    await waitFor(() => expect(document.title).toBe("Netflix Premium — Toko Digital"));
  });

  it("preselects the first in-stock denomination (skipping the out-of-stock one)", async () => {
    renderProduct("netflix-premium", () => productData);
    expect(await screen.findByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument();
    const radio3mo = screen.getByRole("radio", { name: /3 Months/ });
    expect(radio3mo).toBeChecked();
    const selectedPrice = document.querySelector(".font-display.font-semibold.text-pine.text-2xl");
    expect(selectedPrice).toHaveTextContent("Rp219,000");
    // In-stock plan selected -> buy form shown, not the restock CTA.
    expect(screen.getByRole("button", { name: /Add to cart/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Notify me when ready/ })).not.toBeInTheDocument();
    // Live-summary stock line reuses the shared StockBadge (T18) — scoped to
    // #buy-summary since DenominationCard renders its own StockBadge per plan
    // too (e.g. "6 Months" also reads "Available" elsewhere on the page).
    // 3 Months has available=3 <= low_threshold=5.
    const badge = document.querySelector("#buy-summary .rounded-full");
    expect(badge).toHaveClass("bg-amberx-tint", "text-amberx");
    expect(badge).toHaveTextContent("3 left");
  });

  it("selecting another in-stock denomination updates the displayed price, qty max, and stock badge", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const radio6mo = screen.getByRole("radio", { name: /6 Months/ });
    fireEvent.click(radio6mo);
    const selectedPrice = document.querySelector(".font-display.font-semibold.text-pine.text-2xl");
    await waitFor(() => expect(selectedPrice).toHaveTextContent("Rp399,000"));
    const qtyInput = screen.getByLabelText("Quantity") as HTMLInputElement;
    expect(qtyInput.max).toBe("20");
    // 6 Months has available=20 > low_threshold=5 -> "Available" / grass badge.
    const badge = document.querySelector("#buy-summary .rounded-full");
    expect(badge).toHaveClass("bg-grass-tint");
    expect(badge).toHaveTextContent("Available");
  });

  it("swaps to the restock CTA when selecting an out-of-stock denomination", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const radio1mo = screen.getByRole("radio", { name: /1 Month/ });
    fireEvent.click(radio1mo);
    // The 1-month plan is out of stock -> restock CTA replaces the buy form.
    expect(await screen.findByRole("button", { name: /Notify me when ready/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add to cart/ })).not.toBeInTheDocument();
    const badge = document.querySelector("#buy-summary .rounded-full");
    expect(badge).toHaveClass("bg-rust-tint", "text-rust-dark");
    expect(badge).toHaveTextContent("Out of stock");
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

  describe("restock CTA feedback", () => {
    const allOut: ProductPageData = {
      ...productData,
      denominations: productData.denominations.map((d) => ({ ...d, available: 0, in_stock: false })),
    };

    it("hides the Notify button and explains why for a signed-in account without a linked Telegram", async () => {
      renderProduct("netflix-premium", () => allOut, {
        ...context,
        customer: { username: "budi", email: null, telegram_linked: false },
      });
      expect(await screen.findByText(/Link your Telegram account in Settings/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Notify me when ready/ })).not.toBeInTheDocument();
    });

    it("shows the real outcome after subscribing, then disables the button", async () => {
      (apiPost as Mock).mockResolvedValue({ ok: true, result: "subscribed", redirect: "/p/netflix-premium" });
      renderProduct("netflix-premium", () => allOut, {
        ...context,
        customer: { username: "budi", email: null, telegram_linked: true },
      });
      const btn = await screen.findByRole("button", { name: /Notify me when ready/ });
      fireEvent.click(btn);
      expect(await screen.findByRole("status")).toHaveTextContent(/back in stock/);
      expect(btn).toBeDisabled();
    });

    it("shows the unavailable message from an ok:false result", async () => {
      (apiPost as Mock).mockResolvedValue({ ok: false, result: "unavailable", redirect: "/" });
      renderProduct("netflix-premium", () => allOut, {
        ...context,
        customer: { username: "budi", email: null, telegram_linked: true },
      });
      fireEvent.click(await screen.findByRole("button", { name: /Notify me when ready/ }));
      expect(await screen.findByRole("status")).toHaveTextContent(/aren't available for this plan/);
    });

    it("says so when the account is already on the list", async () => {
      (apiPost as Mock).mockResolvedValue({ ok: true, result: "already", redirect: "/p/netflix-premium" });
      renderProduct("netflix-premium", () => allOut, {
        ...context,
        customer: { username: "budi", email: null, telegram_linked: true },
      });
      fireEvent.click(await screen.findByRole("button", { name: /Notify me when ready/ }));
      expect(await screen.findByRole("status")).toHaveTextContent(/already on the list/);
    });
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

  // R4: the detail page used to show no aggregate at all, while the catalog
  // card that linked here (ProductCard.tsx) shows "4.6 · 12 reviews" — the
  // signal disappeared on arrival. This mirrors ProductCard's own
  // formatting/rounding and reuses the same `web.review_count` copy.
  it("shows the aggregate rating (stars, rounded average, review count) matching the catalog card's formatting (R4)", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.getByText("4.6")).toBeInTheDocument();
    expect(screen.getByText("· 12 reviews")).toBeInTheDocument();
  });

  it("says '1 review' (singular) in the aggregate summary for a single review", async () => {
    renderProduct("netflix-premium", () => ({
      ...productData,
      product: { ...productData.product, rating: 5, rating_count: 1 },
    }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.getByText("· 1 review")).toBeInTheDocument();
  });

  it("omits the aggregate rating summary when the product has no ratings yet", async () => {
    renderProduct("netflix-premium", () => ({
      ...productData,
      product: { ...productData.product, rating: null, rating_count: 0 },
    }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText(/^· \d+ reviews$/)).not.toBeInTheDocument();
  });

  // R4 motivation: reviews are capped at 10 server-side (pageData.ts), with
  // no total shown — a product with 200 reviews looked identical to one with
  // 10. The aggregate count must be the TRUE total, not `reviews.length`.
  it("shows the true review total even when it exceeds the number of review cards actually fetched", async () => {
    renderProduct("netflix-premium", () => ({
      ...productData,
      // Only 1 review object arrives (the API caps at 10), but the aggregate
      // count reflects every non-hidden review across the product.
      product: { ...productData.product, rating: 4.3, rating_count: 47 },
    }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.getByText("· 47 reviews")).toBeInTheDocument();
    // Exactly one review card renders below (only 1 arrived from the API),
    // proving the "47" above came from the aggregate, not reviews.length.
    expect(screen.getAllByText(/A\*\*\* ·/)).toHaveLength(1);
  });

  // R1/R2/R5 (Task 1): a pasted "proof" URL with no natural break points used
  // to overflow the card (and the whole page, since nothing constrained it),
  // and blank-line-separated paragraphs collapsed into one run-on sentence
  // because the DOM's literal newlines were rendered with `white-space: normal`.
  it("gives the review comment paragraph break-words and whitespace-pre-line so long tokens wrap and blank lines survive", async () => {
    const longToken = "https://proof.example.com/" + "a".repeat(80);
    const multilineComment = `Barang sesuai deskripsi.\n\nPengiriman cepat, admin ramah.\n\n${longToken}`;
    renderProduct("netflix-premium", () => ({
      ...productData,
      reviews: [{ rating: 4.5, comment: multilineComment, author: "A***", created_at_display: "2026-06-01" }],
    }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const commentParagraph = document.querySelector("p.text-sm.text-ink-soft.mt-2");
    expect(commentParagraph).not.toBeNull();
    // The blank-line-separated text must reach the DOM verbatim (not
    // collapsed/stripped) -- whitespace-pre-line is what makes the browser
    // honor those newlines as line breaks instead of flattening them.
    expect(commentParagraph?.textContent).toBe(multilineComment);
    expect(commentParagraph).toHaveClass("whitespace-pre-line");
    // break-words lets the long unbroken token wrap inside the card instead
    // of forcing the card -- and the page -- wider than the viewport.
    expect(commentParagraph).toHaveClass("break-words");
  });

  // R3 (Task 1): grid rows stretch every card to the tallest sibling by
  // default, so a two-line review card was padded to match a much longer
  // neighbor, leaving a large blank void. items-start lets each card size to
  // its own content.
  it("sizes each review card to its own content instead of stretching to match its row", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const grid = screen.getByText("Great service!").closest(".grid");
    expect(grid).toHaveClass("items-start");
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
    expect(selectedPrice).toHaveTextContent("Rp175,200");
    // One badge on the plan card, one in the live summary.
    expect(screen.getAllByText(/Flash sale/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Flash sale/)[0]).toHaveTextContent("20%");
    expect(screen.getAllByText("Was Rp219,000").length).toBeGreaterThan(0);
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

  // T18: the live summary used to render nothing at all for a non-auto
  // denomination (the old ad-hoc stockChip() returned null whenever
  // !isAuto), unlike the catalog card, which shows "Available" for an
  // all-non-auto product via StockBadge's allNonAuto prop. Reusing
  // StockBadge here closes that gap — a purchasable manual-delivery plan now
  // gets the same positive "Available" signal the card already gave it.
  it("shows Available (not nothing) for a purchasable non-auto denomination (T18)", async () => {
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
    // The DenominationCard now also renders an "Available" pill for a
    // non-auto plan (task-23), so scope this to the live-summary badge.
    const badge = document.querySelector("#buy-summary .rounded-full");
    expect(badge).toHaveTextContent("Available");
    expect(badge).toHaveClass("bg-grass-tint");
  });

  // task-23 (Fase 12 audit follow-up): the short lead paragraph moved OUT of
  // the right column (under the <h1>) and INTO the left column, below the
  // image card — a photo-less Digiflazz product otherwise left a tall empty
  // DefaultThumb well with dead space beside the much taller picker column.
  it("renders product.description in the left column below the image, not inside #product-detail", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const desc = screen.getByText("Shared account, instant delivery.");
    expect(desc).toHaveClass("whitespace-pre-line", "text-ink-soft", "mt-4");
    // No longer nested under the facts / picker column…
    expect(desc.closest("#product-detail")).toBeNull();
    // …and it sits after the image card in document order.
    const imageCard = document.querySelector(".card.overflow-hidden")!;
    expect(imageCard.compareDocumentPosition(desc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders no description block for a product with description: null (Digiflazz import)", async () => {
    renderProduct("netflix-premium", () => ({
      ...productData,
      product: { ...productData.product, description: null },
    }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText("Shared account, instant delivery.")).not.toBeInTheDocument();
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
    // Preselected plan is the first in-stock one, 3 Months at Rp219,000.
    expect(within(bar!).getByText("3 Months")).toBeInTheDocument();
    expect(within(bar!).getByText("Rp219,000")).toBeInTheDocument();
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
    expect(within(bar!).getByText("Rp399,000")).toBeInTheDocument();
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

  it("bounds the media height (no aspect-[4/3] banner) and contains the real image", async () => {
    renderProduct("netflix-premium", () => productData);
    const img = await screen.findByAltText("Netflix Premium");
    expect(img).toHaveClass("object-contain");
    expect(img).not.toHaveClass("object-cover");
    const media = img.closest("picture")?.parentElement;
    expect(media).toHaveClass("h-48", "sm:h-56", "lg:h-64", "xl:h-72", "bg-sand");
    expect(media?.className).not.toContain("aspect-");
  });

  it("starts the detail grid at a single explicit column", async () => {
    renderProduct("netflix-premium", () => productData);
    const h1 = await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(h1.parentElement).toHaveClass("grid-cols-1", "md:grid-cols-2");
  });

  it("lets the plan column shrink so a long unbroken plan name wraps instead of overflowing", async () => {
    renderProduct("netflix-premium", () => productData);
    const h1 = await screen.findByRole("heading", { name: "Netflix Premium" });
    const picker = h1.parentElement?.querySelector("#product-detail");
    expect(picker).toHaveClass("min-w-0");
    expect(picker?.querySelector("#denom-list")).toHaveClass("grid-cols-1");
  });

  it("asks phones for the numeric keypad on the qty field", async () => {
    renderProduct("netflix-premium", () => productData);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.getByLabelText("Quantity")).toHaveAttribute("inputmode", "numeric");
  });

  // Fase 12: the hardcoded Unsplash fallback is gone — a product with no
  // admin-set webImageUrl now renders the DefaultThumb design-system
  // placeholder, keyed by the server-resolved `image_kind`, instead of an
  // unconditional <img> (there used to be no no-image branch at all here).
  it("renders DefaultThumb (no <img>) when the product has no image", async () => {
    const noImage: ProductPageData = {
      ...productData,
      product: { ...productData.product, image: null, image_kind: "voucher" },
    };
    renderProduct("netflix-premium", () => noImage);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByAltText("Netflix Premium")).not.toBeInTheDocument();
    expect(document.querySelector(".lucide-ticket")).toBeInTheDocument();
  });

  it("defaults DefaultThumb to the generic icon when image_kind is absent", async () => {
    const noImage: ProductPageData = {
      ...productData,
      product: { ...productData.product, image: null, image_kind: undefined },
    };
    renderProduct("netflix-premium", () => noImage);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(document.querySelector(".lucide-package")).toBeInTheDocument();
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

  // Fase 12: product.icon_kind is resolved once server-side and forwarded to
  // every DenominationCard as `iconKind` (denom-list has 3 plans in
  // productData, so this also proves it's the SAME icon on every card, not
  // something computed per-denomination).
  it("forwards product.icon_kind to every DenominationCard as the currency chip", async () => {
    const withIcon: ProductPageData = {
      ...productData,
      product: { ...productData.product, icon_kind: "voucher" },
    };
    renderProduct("netflix-premium", () => withIcon);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const denomList = document.querySelector("#denom-list")!;
    expect(denomList.querySelectorAll(".lucide-ticket")).toHaveLength(productData.denominations.length);
  });

  it("renders no currency chip on any DenominationCard when product.icon_kind is null", async () => {
    const noIcon: ProductPageData = {
      ...productData,
      product: { ...productData.product, icon_kind: null },
    };
    renderProduct("netflix-premium", () => noIcon);
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const denomList = document.querySelector("#denom-list")!;
    expect(denomList.querySelectorAll("label.denom-card svg")).toHaveLength(0);
  });
});
