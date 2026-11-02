import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { act, render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CartPage from "./CartPage";
import { apiGet, apiPost } from "../api/client";
import type { CartPageData, ShelfPageData, ShopContext } from "../api/types";
import type { CanonicalProduct } from "../api/canonical";
import type { ProductCardData } from "../components/shop/ProductCard";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const context: ShopContext = {
  lang: "en",
  fx: "16000",
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 4,
  customer: null,
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  wa_number: null,
  tzname: "Asia/Jakarta",
  currency: null,
};

const cartData: CartPageData = {
  items: [
    {
      key: 10,
      denomination_id: 1,
      product_slug: "netflix-premium",
      name: "Netflix Premium - 1 Month",
      image: "/img/netflix.jpg",
      unit_price: "79000",
      qty: 2,
      line_total: "158000",
      available: 5,
      delivery_type: "auto",
      uses_local_inventory: true,
    },
  ],
  subtotal: "158000",
};

function canonicalMonth(id: number, parentName: string): CanonicalProduct {
  return {
    id, supplierSku: null, rawName: "1 Month", rawNameProvenance: "supplier",
    displayName: "1 Month", variant: { type: "subscription", name: "1 Month", residual: [], duration: { value: 1, unit: "month" } },
    qualifiers: [], product: { id: id + 100, name: parentName, gameVariant: null, gameRegion: null },
    category: { id: 1, name: "Premium Apps", group: "PREMIUM_APPS" },
    priceIDR: { currency: "IDR", amountMinor: "79000", scale: 0 },
    displayPrice: { currency: "IDR", amountMinor: "79000", scale: 0 },
    formattedPrice: "Rp79,000", currencyFallback: false, conversion: null,
    availability: { status: "available", purchasable: true }, createdAt: null, generatedAt: "2026-09-30T00:00:00.000Z",
  };
}

function renderCart(respond: (path: string) => unknown, ctx: ShopContext = context, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return ctx;
    return respond(path);
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/cart"]}>
        <Routes>
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<div>checkout-page-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CartPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  // H2 (UI-states audit): GET /cart also serves anonymous visitors, so a
  // signed-in buyer whose session died gets the anonymous (empty) cart back.
  it("says the session ended, not 'cart empty', when a signed-in cart refetch comes back anonymous", async () => {
    let answer: CartPageData = { ...cartData, signed_in: true };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderCart(() => answer, { ...context, customer: { username: "alice", email: null, telegram_linked: false } }, queryClient);
    await screen.findByRole("heading", { name: "Cart (4)" });
    answer = { items: [], subtotal: "0", signed_in: false };
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["cart"] }); });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your session ended. Log in again to see your cart.");
    expect(within(alert).getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login?next=/cart");
    expect(screen.queryByText("Your cart is empty — browse the products.")).not.toBeInTheDocument();
  });

  it("an anonymous visitor's empty cart is still just empty", async () => {
    renderCart(() => ({ items: [], subtotal: "0", signed_in: false }));
    expect(await screen.findByText("Your cart is empty — browse the products.")).toBeInTheDocument();
    expect(screen.queryByText("Your session ended. Log in again to see your cart.")).not.toBeInTheDocument();
  });

  it("preserves a newer quantity draft when the earlier update finishes", async () => {
    let release!: (value: CartPageData) => void;
    (apiPost as Mock).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    renderCart(() => cartData);
    const input = await screen.findByLabelText("Quantity");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "5" } });
    await act(async () => { release({ ...cartData, items: [{ ...cartData.items[0]!, qty: 3 }] }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Update" })).toBeEnabled());
    expect(input).toHaveValue(5);
    expect(apiPost).toHaveBeenCalledExactlyOnceWith("/api/v1/cart/update", { key: 10, qty: 3 });
  });

  it("renders lines + subtotal with the header cart count", async () => {
    renderCart(() => cartData);
    expect(await screen.findByRole("heading", { name: "Cart (4)" })).toBeInTheDocument();
    expect(screen.getByText("Netflix Premium - 1 Month")).toBeInTheDocument();
    expect(screen.getAllByText("Rp158,000").length).toBeGreaterThan(0);
  });

  it("renders a plain page-title without a forced text-2xl! override (H-36)", async () => {
    renderCart(() => cartData);
    const h1 = await screen.findByRole("heading", { name: "Cart (4)" });
    expect(h1).toHaveClass("page-title");
    expect(h1.className).not.toContain("text-2xl");
  });

  it("identifies two different parent products with the same canonical plan name", async () => {
    const items = [
      { ...cartData.items[0]!, qty: 1, line_total: "79000", canonical: canonicalMonth(1, "Netflix Premium") },
      { ...cartData.items[0]!, key: 11, denomination_id: 2, product_slug: "spotify-premium", name: "Spotify legacy name", qty: 1, line_total: "79000", canonical: canonicalMonth(2, "Spotify Premium") },
    ];
    renderCart(() => ({ ...cartData, items }));
    expect(await screen.findByRole("link", { name: "Netflix Premium · 1 Month" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Spotify Premium · 1 Month" })).toBeInTheDocument();
  });

  it("shows an identical canonical parent and variant once while keeping qualifiers", async () => {
    const canonical: CanonicalProduct = {
      ...canonicalMonth(1, "Netflix Premium"), displayName: "Netflix Premium",
      variant: { type: "unknown", name: "Netflix Premium", residual: [] }, qualifiers: ["Indonesia"],
    };
    renderCart(() => ({ ...cartData, items: [{ ...cartData.items[0]!, canonical }] }));
    expect(await screen.findByRole("link", { name: "Netflix Premium · Indonesia" })).toBeInTheDocument();
    expect(screen.queryByText("Netflix Premium · Netflix Premium · Indonesia")).not.toBeInTheDocument();
  });

  // Task 5 fix pass (review Minor #1): pin the USD display state on a sweep
  // site, so a regression back to a plain formatIdr subtotal is caught.
  // 158000 / 16000 = 9.875 -> ceil to $9.88; 79000 / 16000 -> $4.94.
  it("shows a $ subtotal and no ≈ hint chip for a USD-preference viewer", async () => {
    renderCart(() => cartData, { ...context, currency: "USD" });
    await screen.findByRole("heading", { name: "Cart (4)" });
    // The context query (which carries `currency`) may land after the cart.
    expect((await screen.findAllByText("$9.88")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("$4.94").length).toBeGreaterThan(0);
    expect(screen.queryByText("Rp158,000")).not.toBeInTheDocument();
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });

  it("editing qty then clicking update posts the new qty and re-renders from the response", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    const row = screen.getByText("Netflix Premium - 1 Month").closest("div.p-4") as HTMLElement;
    const qtyInput = within(row).getByLabelText("Quantity") as HTMLInputElement;
    expect(qtyInput.value).toBe("2");
    fireEvent.change(qtyInput, { target: { value: "3" } });
    expect(qtyInput.value).toBe("3");

    const updated: CartPageData = {
      items: [{ ...cartData.items[0]!, qty: 3, line_total: "237000" }],
      subtotal: "237000",
    };
    (apiPost as Mock).mockResolvedValue(updated);

    fireEvent.click(within(row).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/cart/update", { key: 10, qty: 3 }));
    expect(await screen.findAllByText("Rp237,000")).not.toHaveLength(0);
  });

  it("shows the server's accepted quantity after update, including a server clamp", async () => {
    renderCart(() => cartData);
    const input = await screen.findByLabelText("Quantity");
    fireEvent.change(input, { target: { value: "3" } });
    (apiPost as Mock).mockResolvedValue({ ...cartData, items: [{ ...cartData.items[0]!, qty: 1, line_total: "79000" }], subtotal: "79000" });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(input).toHaveValue(1));
    expect(apiPost).toHaveBeenCalledExactlyOnceWith("/api/v1/cart/update", { key: 10, qty: 3 });
  });

  it("follows refetched quantity while clean and preserves an unsaved draft on refetch/error", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderCart(() => cartData, context, client);
    const input = await screen.findByLabelText("Quantity");
    const replaceQty = async (qty: number) => act(async () => {
      client.setQueriesData({ queryKey: ["cart"] }, { ...cartData, items: [{ ...cartData.items[0]!, qty }] });
    });
    await replaceQty(4);
    await waitFor(() => expect(input).toHaveValue(4));
    fireEvent.change(input, { target: { value: "3" } });
    await replaceQty(1);
    expect(input).toHaveValue(3);
    (apiPost as Mock).mockRejectedValue(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Update" })).toBeEnabled());
    expect(input).toHaveValue(3);
    expect(apiPost).toHaveBeenCalledExactlyOnceWith("/api/v1/cart/update", { key: 10, qty: 3 });
  });

  // Removal now takes two taps: the trash icon only opens an inline
  // confirmation, and the confirm button inside it is what posts.
  it("removing a line posts remove and empties the cart", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    (apiPost as Mock).mockResolvedValue({ items: [], subtotal: "0" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Remove this item from your cart?");
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/cart/remove", { key: 10 }));
    expect(await screen.findByText("Your cart is empty — browse the products.")).toBeInTheDocument();
    // Points at /products, not the homepage: a button labelled "Browse
    // products" had nowhere better to go before that page existed.
    expect(screen.getByRole("link", { name: "Browse products" })).toHaveAttribute("href", "/products");
  });

  it("cancelling the remove confirmation leaves the line and its controls alone", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByText("Netflix Premium - 1 Month")).toBeInTheDocument();
    // The confirmation replaces the quantity controls, so cancelling has to
    // bring them back — otherwise the row is left unusable.
    expect(screen.getByLabelText("Quantity")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  // Phones show a QWERTY keyboard for type="number" unless inputMode says
  // otherwise, which is a poor way to type a digit into a 64px field.
  it("hints a numeric keypad on the quantity field", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.getByLabelText("Quantity")).toHaveAttribute("inputmode", "numeric");
  });

  // jsdom has no matchMedia, so useIsDesktop() reports mobile — this is the
  // small-screen layout: checkout is reachable from the sticky bar, and the
  // summary card drops its own copy of the link so there is only ever one.
  // The sticky bar's CTA is StickyPurchaseBar's button-based primary action
  // (Fase 7c — the bar has no Link variant), not a literal <a>, so this now
  // looks for a button rather than a link; the destination (navigate
  // ("/checkout")) and the "exactly one control" property are unchanged.
  it("puts the checkout call to action in a single reachable place on mobile", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.queryAllByRole("link", { name: /Continue to payment/ })).toHaveLength(0);
    const checkoutButtons = screen.getAllByRole("button", { name: /Continue to payment/ });
    expect(checkoutButtons).toHaveLength(1);
  });

  // Fix 1 (Task 13 review, Important): the sticky bar's CTA button navigates
  // programmatically (StickyPurchaseBar has no Link variant), so nothing
  // else in the suite verified it still lands on /checkout after the
  // migration off the old <Link href="/checkout">. Same convention as
  // ProductPage.test.tsx's "buys through the same mutation..." case: assert
  // the destination route's stub actually mounts after the click.
  it("navigates to /checkout when the mobile sticky bar's CTA is clicked", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/ }));
    expect(await screen.findByText("checkout-page-stub")).toBeInTheDocument();
  });

  it("renders the empty-cart branch when the cart starts empty", async () => {
    renderCart(() => ({ items: [], subtotal: "0" }));
    expect(await screen.findByText("Your cart is empty — browse the products.")).toBeInTheDocument();
    expect(screen.queryByText("Summary")).not.toBeInTheDocument();
  });

  // E3: a stepper reading "1 · Cart → 2 · Payment → 3 · Done" above an empty
  // state implies a checkout in progress when there's nothing to check out.
  it("hides the checkout stepper when the cart is empty", async () => {
    renderCart(() => ({ items: [], subtotal: "0" }));
    await screen.findByText("Your cart is empty — browse the products.");
    expect(screen.queryByRole("listitem", { name: "1 · Cart" })).not.toBeInTheDocument();
  });

  it("shows the checkout stepper on step 1 while the cart has items", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.getByRole("listitem", { name: "1 · Cart" })).toHaveAttribute("aria-current", "step");
  });

  it("hides the stepper once the last line is removed", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.getByRole("listitem", { name: "1 · Cart" })).toBeInTheDocument();
    (apiPost as Mock).mockResolvedValue({ items: [], subtotal: "0" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByText("Your cart is empty — browse the products.");
    expect(screen.queryByRole("listitem", { name: "1 · Cart" })).not.toBeInTheDocument();
  });

  // Task 10 (E4): an empty cart is one of the pages where shopping IS the
  // next step, so the shelf fetch fires (unlike SupportPage/the checkout
  // error state, which stay shelf-free on purpose).
  it("shows a suggested-products shelf once it loads, without delaying the empty-cart card", async () => {
    const suggestedProduct: ProductCardData = {
      slug: "spotify-premium",
      name: "Spotify Premium",
      category_name: "Streaming",
      from_price: "45000",
      variant_count: 1,
      image: "",
      available: 3,
      rating: null,
      rating_count: 0,
      bulk_discount: null,
      bulk_min_qty: null,
      all_non_auto: false,
    };
    const shelf: ShelfPageData = { products: [suggestedProduct], low_threshold: 5 };
    (apiGet as Mock).mockImplementation(async (path: string) => {
      if (path === "/api/v1/pages/context") return context;
      if (path === "/api/v1/pages/suggestions") return shelf;
      return { items: [], subtotal: "0" };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/cart"]}>
          <Routes>
            <Route path="/cart" element={<CartPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The empty-cart card is there before the shelf even could be — same
    // request wave, but the card renders off `cart`, not off `suggested`.
    expect(await screen.findByText("Your cart is empty — browse the products.")).toBeInTheDocument();
    expect(await screen.findByText("You might also like")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Spotify Premium/ })).toHaveAttribute("href", "/p/spotify-premium");
  });

  it("shows the login-to-checkout hint for a guest without singling out Telegram (STO-009)", async () => {
    renderCart(() => cartData);
    expect(await screen.findByText("Sign in to continue — your cart comes along.")).toBeInTheDocument();
  });

  // STO-008: the cart previously offered only "Continue to payment", with no
  // way back to browsing.
  it("offers a Continue shopping link back to the homepage", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/");
  });

  // Flash sales: `unit_price` on the line is ALREADY the sale price, so the
  // line only adds the ⚡ badge and the struck-through pre-sale figure.
  it("shows the flash badge and struck-through base price on a discounted line", async () => {
    const endsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const onSale: CartPageData = {
      items: [
        {
          ...cartData.items[0]!,
          unit_price: "63200",
          line_total: "126400",
          flash: { discount_percent: "20", base_price: "79000", ends_at: endsAt },
        },
      ],
      subtotal: "126400",
    };
    renderCart(() => onSale);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.getByText(/Flash sale/)).toHaveTextContent("20%");
    expect(screen.getByText("Was Rp79,000")).toBeInTheDocument();
    expect(screen.getAllByText("Rp63,200").length).toBeGreaterThan(0);
  });

  it("shows no flash badge or struck-through price on a line with no sale", async () => {
    renderCart(() => cartData);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.queryByText(/Flash sale/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Was /)).not.toBeInTheDocument();
  });

  // Bug B (Task 6): non-auto lines never have stock rows by design (available
  // is always 0), so `qty > available` was ALWAYS true for a legitimate
  // manual/manual_with_info cart line — the "N left" warning must be
  // suppressed for those, not driven by the meaningless available count.
  it("does not show the stock-shortage warning for a non-auto line even though qty > available", async () => {
    const manualCart: CartPageData = {
      items: [{ ...cartData.items[0]!, delivery_type: "manual", uses_local_inventory: false, available: 0, qty: 3 }],
      subtotal: "237000",
    };
    renderCart(() => manualCart);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.queryByText(/left$/)).not.toBeInTheDocument();
  });

  it("does not show the stock-shortage warning for an auto + provider line the server marks non-local", async () => {
    const providerCart: CartPageData = {
      items: [{ ...cartData.items[0]!, delivery_type: "auto", uses_local_inventory: false, available: 0, qty: 3 }],
      subtotal: "237000",
    };
    renderCart(() => providerCart);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.queryByText(/left$/)).not.toBeInTheDocument();
  });

  it("still warns on a local-inventory line asking for more than is in stock", async () => {
    const shortCart: CartPageData = {
      items: [{ ...cartData.items[0]!, uses_local_inventory: true, available: 1, qty: 3 }],
      subtotal: "237000",
    };
    renderCart(() => shortCart);
    await screen.findByRole("heading", { name: "Cart (4)" });
    expect(screen.getByText(/1 left$/)).toBeInTheDocument();
  });
});

describe("CartPage — volume tiers", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  const pricing = (qty: number, unit: string, total: string, savings: string, tier: number | null) => ({
    quantity: qty,
    base_unit_price: "10000",
    final_unit_price: unit,
    original_subtotal: String(10000 * qty),
    final_subtotal: total,
    savings,
    applied_tier: tier ? { min_quantity: tier, discount_type: "FIXED_UNIT_PRICE" as const, discount_value: unit } : null,
  });
  const line = (key: number, qty: number, p: ReturnType<typeof pricing>) => ({
    key,
    denomination_id: key,
    product_slug: `plan-${key}`,
    name: `Plan ${key}`,
    image: "",
    unit_price: "10000",
    qty,
    line_total: String(10000 * qty),
    available: 0,
    delivery_type: "manual",
    uses_local_inventory: false,
    pricing: p,
  });
  const tieredCart: CartPageData = {
    items: [line(1, 5, pricing(5, "6000", "30000", "20000", 5))],
    subtotal: "50000",
    bulk_discount: "20000",
    total: "30000",
  };

  it("shows the server's discounted unit, the net line total and the saving, and a summary equal to checkout's", async () => {
    renderCart(() => tieredCart);
    await screen.findByText("Plan 1");
    expect(screen.getAllByText("Rp6,000 each").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Was Rp10,000")[0]).toHaveClass("sr-only");
    const note = screen.getByTestId("tier-line-note");
    expect(note).toHaveTextContent("5 × Rp6,000");
    expect(note).toHaveTextContent("Rp30,000");
    expect(note).toHaveTextContent("Quantity deal: you save Rp20,000");
    // Summary: subtotal, the quantity deal, and the total checkout will show.
    expect(screen.getByText("Quantity deal")).toBeInTheDocument();
    expect(screen.getByText("−Rp20,000")).toBeInTheDocument();
    expect(screen.getAllByText("Rp30,000").length).toBeGreaterThan(1);
  });

  it("shows no tier note on a line without a tier", async () => {
    renderCart(() => ({ items: [line(2, 2, pricing(2, "10000", "20000", "0", null))], subtotal: "20000", bulk_discount: "0", total: "20000" }));
    await screen.findByText("Plan 2");
    expect(screen.queryByTestId("tier-line-note")).not.toBeInTheDocument();
    expect(screen.queryByText("Quantity deal")).not.toBeInTheDocument();
  });

  it("applies only the newest cart answer: a slow earlier update can't overwrite a later one's prices", async () => {
    const twoLines: CartPageData = {
      items: [line(1, 1, pricing(1, "10000", "10000", "0", null)), line(2, 1, pricing(1, "10000", "10000", "0", null))],
      subtotal: "20000",
      bulk_discount: "0",
      total: "20000",
    };
    const releases: Array<(value: CartPageData) => void> = [];
    (apiPost as Mock).mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
    renderCart(() => twoLines);
    await screen.findByText("Plan 1");
    const [qtyA, qtyB] = screen.getAllByLabelText("Quantity");
    const [updateA, updateB] = screen.getAllByRole("button", { name: "Update" });

    fireEvent.change(qtyA!, { target: { value: "3" } });
    fireEvent.click(updateA!);
    fireEvent.change(qtyB!, { target: { value: "5" } });
    fireEvent.click(updateB!);
    await waitFor(() => expect(releases).toHaveLength(2));

    // The later request (both lines changed) answers first…
    const afterBoth: CartPageData = {
      items: [line(1, 3, pricing(3, "8000", "24000", "6000", 3)), line(2, 5, pricing(5, "6000", "30000", "20000", 5))],
      subtotal: "80000",
      bulk_discount: "26000",
      total: "54000",
    };
    await act(async () => releases[1]!(afterBoth));
    await waitFor(() => expect(screen.getByText("−Rp26,000")).toBeInTheDocument());
    // …then the earlier one lands late, describing only line A's change.
    const afterA: CartPageData = {
      items: [line(1, 3, pricing(3, "8000", "24000", "6000", 3)), line(2, 1, pricing(1, "10000", "10000", "0", null))],
      subtotal: "40000",
      bulk_discount: "6000",
      total: "34000",
    };
    await act(async () => releases[0]!(afterA));
    expect(screen.getByText("−Rp26,000")).toBeInTheDocument();
    expect(screen.queryByText("−Rp6,000")).not.toBeInTheDocument();
    expect(screen.getAllByText("Rp54,000").length).toBeGreaterThan(0);
  });
});
