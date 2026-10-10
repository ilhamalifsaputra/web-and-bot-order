import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import InstantBuyPage from "./InstantBuyPage";
import ProductPage from "./ProductPage";
import { apiGet, apiPost } from "../api/client";
import type { CartPageData, CheckoutData, ProductPageData, ShopContext } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

// Task 6's trust-block section (What you get/Terms/Warranty) mounts with
// Framer Motion's `whileInView`, which throws in jsdom without an
// IntersectionObserver — same no-op stub ProductPage.test.tsx uses.
class NoOpIntersectionObserver {
  static primaryCallback: IntersectionObserverCallback | null = null;
  static primary: Element | null = null;
  constructor(private callback: IntersectionObserverCallback) {}
  observe(element: Element) {
    if (element.id === "instant-buy-submit") {
      NoOpIntersectionObserver.primaryCallback = this.callback;
      NoOpIntersectionObserver.primary = element;
    }
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
vi.stubGlobal("IntersectionObserver", NoOpIntersectionObserver);

const context: ShopContext = {
  lang: "en",
  fx: "16000",
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 0,
  customer: { username: "alice", email: null, telegram_linked: false },
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  wa_number: null,
  tzname: "Asia/Jakarta",
  currency: null,
};

const productData: ProductPageData = {
  product: {
    slug: "mobile-legends-diamonds",
    name: "Mobile Legends Diamonds",
    description: "Instant top-up.",
    what_you_get: null,
    terms: null,
    warranty_note: null,
    category_name: "Top Up Game",
    category_slug: "top-up-game",
    image: "/img/mlbb.jpg",
    rating: null,
    rating_count: 0,
    checkout_flow: "instant",
    template: "game",
  },
  denominations: [
    {
      id: 1,
      name: "86 Diamonds",
      duration_label: null,
      price: "20000",
      warranty_days: 0,
      available: 0,
      in_stock: false,
      bulk: null,
      delivery_type: "manual_with_info",
      additional_fields: [
        { key: "user_id", label: { id: "ID Pengguna", en: "User ID" }, type: "text", required: true, options: [], placeholder: "123456789" },
        { key: "zone_id", label: { id: "Zone ID", en: "Zone ID" }, type: "text", required: true, options: [], placeholder: "1234" },
      ],
    },
    {
      id: 2,
      name: "172 Diamonds",
      duration_label: null,
      price: "38000",
      warranty_days: 0,
      available: 0,
      in_stock: false,
      bulk: null,
      delivery_type: "manual_with_info",
      additional_fields: [
        { key: "user_id", label: { id: "ID Pengguna", en: "User ID" }, type: "text", required: true, options: [], placeholder: "123456789" },
        { key: "zone_id", label: { id: "Zone ID", en: "Zone ID" }, type: "text", required: true, options: [], placeholder: "1234" },
      ],
    },
  ],
  default_restock_denomination_id: 1,
  related_products: [],
  reviews: [],
  low_threshold: 5,
};

const checkoutData: CheckoutData = {
  items_empty: false,
  items: [{ denomination_id: 1, delivery_type: "manual_with_info", additional_fields: productData.denominations[0]!.additional_fields, qty: 1 }],
  subtotal: "20000",
  bulk_discount: "0",
  voucher_discount: "0",
  total: "20000",
  qris_admin_fee: "240",
  qris_grand_total: "20240",
  total_usdt: "1.25",
  voucher_code: "",
  error_key: null,
  binance_enabled: true,
  bybit_enabled: false,
  bybit_bsc_enabled: false,
  idr_enabled: false,
  paydisini_enabled: false,
  nowpayments_enabled: false,
  wallet_idr: "0",
  wallet_usdt: "0",
  wallet_idr_enabled: true,
  wallet_usdt_enabled: true,
  is_guest: false,
  below_all_minimums: false,
};

/** Every cart endpoint this page must never touch again (final-review N2).
 * Kept in one place so each assertion below checks the whole family, not just
 * whichever call the old cart-sync design happened to make first. */
const CART_PATHS = ["/api/v1/cart", "/api/v1/cart/remove"];

/** Every recorded apiGet/apiPost path that hit the cart (or the cart-based
 * checkout summary) — the regression assertion for N2. */
function cartCalls(): unknown[][] {
  return [...(apiGet as Mock).mock.calls, ...(apiPost as Mock).mock.calls].filter(
    (c) => CART_PATHS.includes(c[0] as string) || c[0] === "/api/v1/checkout" || c[0] === "/api/v1/checkout/voucher/preview",
  );
}

/**
 * Mocks the cart-free instant-buy backend: `POST /api/v1/topup/preview` prices
 * the requested denomination (both the load/denomination-switch trigger and the
 * voucher-apply trigger go through it), and nothing reads or writes a cart.
 *
 * The cart endpoints ARE still answered rather than thrown on, deliberately: a
 * regression that starts touching the cart again has to be caught by the
 * explicit "never called" assertions below, not masked by a thrown error that
 * reads like an unrelated failure.
 *
 * `preview` lets a test price per denomination / per voucher code; `extraPost`
 * (via a per-test mockImplementation override) still works as before for the
 * order endpoint.
 */
function renderInstantBuy(
  options: {
    product?: ProductPageData;
    checkout?: CheckoutData;
    slug?: string;
    preview?: (body: Record<string, unknown>) => CheckoutData;
    ctx?: ShopContext;
    throughProductPage?: boolean;
  } = {},
) {
  const ctx = options.ctx ?? context;
  const product = options.product ?? productData;
  const checkout = options.checkout ?? checkoutData;
  const slug = options.slug ?? product.product.slug;
  const emptyCart: CartPageData = { items: [], subtotal: "0" };

  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return ctx;
    if (path === `/api/v1/pages/product/${slug}`) return product;
    if (path === "/api/v1/cart") return emptyCart;
    if (path === "/api/v1/checkout") return checkout;
    throw new Error(`unexpected GET ${path}`);
  });

  (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>) => {
    if (path === "/api/v1/topup/preview") return options.preview ? options.preview(body) : checkout;
    if (CART_PATHS.includes(path)) return emptyCart;
    throw new Error(`unexpected POST ${path} — override apiPost in the test for this path`);
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/p/${slug}`]}>
        <Routes>
          <Route path="/p/:slug" element={options.throughProductPage ? <ProductPage /> : <InstantBuyPage />} />
          <Route path="/checkout/:code/pay" element={<div>pay-page-stub</div>} />
          <Route path="/login" element={<div>login-page-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe("InstantBuyPage", () => {
  it.each([false, true])("preserves account answers when choosing a different diamond amount (product route: %s)", async (throughProductPage) => {
    renderInstantBuy({ throughProductPage });
    await screen.findByText("Summary");
    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "4531475056881819915" } });
    fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "0012" } });

    let releasePreview!: (data: CheckoutData) => void;
    (apiPost as Mock).mockImplementation((path: string) => {
      if (path === "/api/v1/topup/preview") return new Promise<CheckoutData>((resolve) => { releasePreview = resolve; });
      return new Promise(() => {});
    });
    fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));
    await waitFor(() => expect(releasePreview).toBeDefined());
    expect(screen.getByLabelText("User ID")).toHaveValue("4531475056881819915");
    expect(screen.getByLabelText("Zone ID")).toHaveValue("0012");
    expect(screen.getByRole("button", { name: /Buy now/ })).toBeDisabled();

    await act(async () => { releasePreview({ ...checkoutData, total: "38000", total_usdt: "2.375" }); });
    await waitFor(() => expect(screen.getByRole("button", { name: /Buy now/ })).toBeEnabled());
    expect(within(document.getElementById("checkout-summary")!).getByText("172 Diamonds")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Buy now/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/order", expect.objectContaining({
      denomination_id: 2,
      customer_data: [{ user_id: "4531475056881819915", zone_id: "0012" }],
    }), expect.anything()));
  });

  it.each([false, true])("preserves account answers and selected plan during a currency refetch (product route: %s)", async (throughProductPage) => {
    const { queryClient } = renderInstantBuy({ throughProductPage });
    await screen.findByText("Summary");
    fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/preview", { denomination_id: 2, qty: 1 }));
    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "4531475056881819915" } });
    fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "0012" } });

    let releaseProduct!: (data: ProductPageData) => void;
    let releasePreview!: (data: CheckoutData) => void;
    (apiGet as Mock).mockImplementation(() => new Promise<ProductPageData>((resolve) => { releaseProduct = resolve; }));
    (apiPost as Mock).mockImplementation((path: string) => {
      if (path === "/api/v1/topup/preview") return new Promise<CheckoutData>((resolve) => { releasePreview = resolve; });
      return new Promise(() => {});
    });
    await act(async () => { queryClient.setQueryData(["context"], { ...context, currency: "USD" }); });
    await waitFor(() => expect(releaseProduct).toBeDefined());
    expect(screen.getByLabelText("User ID")).toHaveValue("4531475056881819915");
    expect(screen.getByLabelText("Zone ID")).toHaveValue("0012");
    expect(screen.getByRole("radio", { name: /172 Diamonds/ })).toBeChecked();
    expect(screen.getByRole("button", { name: /Buy now/ })).toBeDisabled();

    await act(async () => { releaseProduct({ ...productData, denominations: productData.denominations.map((d) => ({ ...d, price: "40000" })) }); });
    await waitFor(() => expect(releasePreview).toBeDefined());
    await act(async () => { releasePreview({ ...checkoutData, total: "40000", total_usdt: "2.50" }); });
    await waitFor(() => expect(screen.getByRole("button", { name: /Buy now/ })).toHaveTextContent("$2.50"));
    expect(screen.getByLabelText("User ID")).toHaveValue("4531475056881819915");
    expect(screen.getByLabelText("Zone ID")).toHaveValue("0012");
    fireEvent.click(screen.getByRole("button", { name: /Buy now/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/order", expect.objectContaining({
      denomination_id: 2,
      customer_data: [{ user_id: "4531475056881819915", zone_id: "0012" }],
    }), expect.anything()));
  });

  it("clears account answers when a denomination requires a different field schema", async () => {
    const fields = [{ ...productData.denominations[0]!.additional_fields[0]!, type: "number" as const }];
    renderInstantBuy({ product: { ...productData, denominations: [productData.denominations[0]!, { ...productData.denominations[1]!, additional_fields: fields }] } });
    await screen.findByText("Summary");
    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "old-account" } });
    fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "0012" } });
    fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/preview", { denomination_id: 2, qty: 1 }));
    expect(screen.getByLabelText("User ID")).toHaveValue("");
    expect(screen.queryByLabelText("Zone ID")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Buy now/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Buy now/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Buy now/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/order", expect.objectContaining({
      denomination_id: 2, customer_data: [{ user_id: "1234567" }],
    }), expect.anything()));
  });

  it("clears account answers on navigation to a cached different game with the same fields", async () => {
    const otherProduct = { ...productData, product: { ...productData.product, slug: "another-game", name: "Another Game" } };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(["context"], context);
    for (const product of [productData, otherProduct]) {
      queryClient.setQueryData(["product", product.product.slug, null, "en", undefined], product);
    }
    (apiPost as Mock).mockResolvedValue(checkoutData);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/p/${productData.product.slug}`]}>
          <Link to="/p/another-game">Another game</Link>
          <Routes><Route path="/p/:slug" element={<ProductPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("Summary");
    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "4531475056881819915" } });
    fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "0012" } });
    fireEvent.click(screen.getByRole("link", { name: "Another game" }));
    await screen.findByRole("heading", { name: "Another Game" });
    expect(screen.getByLabelText("User ID")).toHaveValue("");
    expect(screen.getByLabelText("Zone ID")).toHaveValue("");
    expect(screen.getByRole("button", { name: /Buy now/ })).toBeDisabled();
  });

  it("renders Delta Player ID only and collects configured fields on AUTO", async () => {
    const delta = { ...productData, product: { ...productData.product, name: "Delta Force", slug: "delta-force" }, denominations: [{ ...productData.denominations[0]!, delivery_type: "auto", in_stock: true, additional_fields: [{ key: "player_id", label: { id: "Player ID", en: "Player ID" }, type: "number" as const, required: true, options: [], placeholder: "" }] }] };
    renderInstantBuy({ product: delta });
    expect(await screen.findByLabelText(/Player ID/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Zone ID|Server/)).not.toBeInTheDocument();
  });
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    NoOpIntersectionObserver.primaryCallback = null;
    NoOpIntersectionObserver.primary = null;
  });

  it("keeps a primary CTA in flow, observes its late mount, and toggles the mobile bar", async () => {
    renderInstantBuy();
    await screen.findByText("Summary");
    const primary = await screen.findByRole("button", { name: /Buy now/ });
    expect(primary.closest("#checkout-summary")).not.toBeNull();
    await waitFor(() => expect(NoOpIntersectionObserver.primary).toBe(primary));
    const intersect = (isIntersecting: boolean) => act(() => NoOpIntersectionObserver.primaryCallback?.([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(screen.queryByRole("region", { name: "Purchase" })).not.toBeInTheDocument();
    intersect(false);
    expect(screen.getByRole("region", { name: "Purchase" })).toBeInTheDocument();
    intersect(true);
    expect(screen.queryByRole("region", { name: "Purchase" })).not.toBeInTheDocument();
  });

  it("shows only nonempty configured account answers in the summary, preserving long IDs", async () => {
    const product = { ...productData, denominations: [{ ...productData.denominations[0]!, additional_fields: [productData.denominations[0]!.additional_fields[0]!, { ...productData.denominations[0]!.additional_fields[1]!, required: false }] }] };
    renderInstantBuy({ product });
    await screen.findByText("Summary");
    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: " 4531475056881819915 " } });
    const summary = within(document.getElementById("checkout-summary")!);
    expect(summary.getByText("86 Diamonds")).toBeInTheDocument();
    expect(summary.getByText("4531475056881819915")).toBeInTheDocument();
    expect(summary.queryByText("Zone ID")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Buy now/ })).not.toBeDisabled();
    expect(screen.getByRole("radio", { name: /86 Diamonds/ })).toHaveProperty("form", document.getElementById("buy-form"));
  });

  it("blocks an invalid metadata SKU with an inline configuration reason", async () => {
    renderInstantBuy({ product: { ...productData, denominations: [{ ...productData.denominations[0]!, additional_fields: [], input_configuration_valid: false }] } });
    expect(await screen.findByText(/input configuration/i)).toBeInTheDocument();
    expect((apiPost as Mock).mock.calls.some((c) => c[0] === "/api/v1/topup/order")).toBe(false);
  });

  it("keeps field validation visible when selecting another plan with the same fields", async () => {
    renderInstantBuy();
    await screen.findByText("Summary");
    const userId = screen.getByLabelText("User ID");
    expect(userId).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.blur(userId);
    expect(userId).toHaveAttribute("aria-invalid", "true");
    fireEvent.submit(document.getElementById("buy-form")!);
    expect(screen.getByLabelText("Zone ID")).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));
    await screen.findByText("Summary");
    expect(screen.getByLabelText("User ID")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Zone ID")).toHaveAttribute("aria-invalid", "true");
    expect((apiPost as Mock).mock.calls.some((c) => c[0] === "/api/v1/topup/order")).toBe(false);
  });

  it("keeps the newest voucher price when two applies resolve out of order and preserves applied code while editing", async () => {
    renderInstantBuy();
    await screen.findByText("Summary");
    const base = (apiPost as Mock).getMockImplementation()!;
    const releases: Record<string, (data: CheckoutData) => void> = {};
    (apiPost as Mock).mockImplementation((path: string, body: Record<string, unknown>) => {
      if (path === "/api/v1/topup/preview" && body.voucher_code) return new Promise((resolve) => { releases[String(body.voucher_code)] = resolve; });
      if (path === "/api/v1/topup/order") return new Promise(() => {});
      return base(path, body);
    });
    const input = screen.getByPlaceholderText("Code");
    fireEvent.change(input, { target: { value: "OLD" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(releases.OLD).toBeDefined());
    fireEvent.change(input, { target: { value: "NEW" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(releases.NEW).toBeDefined());
    await act(async () => { releases.NEW!({ ...checkoutData, total: "17000", voucher_discount: "3000", voucher_code: "NEW" }); });
    await act(async () => { releases.OLD!({ ...checkoutData, total: "19000", voucher_discount: "1000", voucher_code: "OLD" }); });
    const summary = within(document.getElementById("checkout-summary")!);
    expect(summary.queryByText("Rp19,000")).not.toBeInTheDocument();
    expect(summary.getByText("Rp17,000")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "EDITED" } });
    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
    fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Buy now/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/order", expect.objectContaining({ voucher_code: "NEW" }), expect.anything()));
  });

  it("ignores voucher results from a previous currency/pricing context", async () => {
    const { queryClient } = renderInstantBuy();
    await screen.findByText("Summary");
    const base = (apiPost as Mock).getMockImplementation()!;
    let release!: (data: CheckoutData) => void;
    (apiPost as Mock).mockImplementation((path: string, body: Record<string, unknown>) => {
      if (path === "/api/v1/topup/preview" && body.voucher_code) return new Promise((resolve) => { release = resolve; });
      return base(path, body);
    });
    fireEvent.change(screen.getByPlaceholderText("Code"), { target: { value: "OLD" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => { queryClient.setQueryData(["context"], { ...context, currency: "USD", pricing_context: "new-session" }); });
    await waitFor(() => expect(screen.getByRole("button", { name: /Buy now/ })).toHaveTextContent("$1.25"));
    await act(async () => { release({ ...checkoutData, total: "16000", voucher_code: "OLD" }); });
    expect(screen.getByRole("button", { name: /Buy now/ })).toHaveTextContent("$1.25");
    expect(screen.queryByText("Applied: OLD")).not.toBeInTheDocument();
  });

  it("blocks voucher repricing, ignores an abandoned SKU response, and submits only the applied code", async () => {
    renderInstantBuy();
    await screen.findByText("Summary");
    const base = (apiPost as Mock).getMockImplementation()!;
    let resolveVoucher!: (data: CheckoutData) => void;
    (apiPost as Mock).mockImplementation((path: string, body: Record<string, unknown>) => {
      if (path === "/api/v1/topup/preview" && body.voucher_code === "OLD") return new Promise((resolve) => { resolveVoucher = resolve; });
      if (path === "/api/v1/topup/order") return new Promise(() => {});
      return base(path, body);
    });
    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
    fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1234" } });
    fireEvent.change(screen.getByPlaceholderText("Code"), { target: { value: "OLD" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Buy now/ })).toBeDisabled());
    fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/preview", { denomination_id: 2, qty: 1 }));
    await act(async () => { resolveVoucher({ ...checkoutData, total: "1", qris_grand_total: "1", voucher_code: "OLD" }); });
    expect(within(document.getElementById("checkout-summary")!).queryByText("Rp1")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: " 4531475056881819915 " } });
    fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: " 0012 " } });
    fireEvent.change(screen.getByPlaceholderText("Code"), { target: { value: "UNAPPLIED" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Buy now/ })).not.toBeDisabled());
    const button = screen.getByRole("button", { name: /Buy now/ });
    act(() => { button.click(); button.click(); });
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/order", expect.objectContaining({ denomination_id: 2, voucher_code: "", customer_data: [{ user_id: "4531475056881819915", zone_id: "0012" }] }), expect.anything()));
    expect((apiPost as Mock).mock.calls.filter((c) => c[0] === "/api/v1/topup/order")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Processing/ })).toBeDisabled();
  });

  it("renders the account field(s) for the selected (default) denomination", async () => {
    renderInstantBuy();
    expect(await screen.findByRole("heading", { name: "Mobile Legends Diamonds" })).toBeInTheDocument();
    expect(await screen.findByLabelText("User ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Zone ID")).toBeInTheDocument();
  });

  it("previews the default denomination on load, then re-previews when another is picked", async () => {
    renderInstantBuy();
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/preview", { denomination_id: 1, qty: 1 }),
    );
    // The live totals card only renders once the preview lands.
    expect(await screen.findByText("Summary")).toBeInTheDocument();

    (apiPost as Mock).mockClear();
    fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/preview", { denomination_id: 2, qty: 1 }),
    );
  });

  // FINAL-REVIEW N2, the whole point of the cart-free redesign: this page used
  // to sync its selection into the server-side cart, CLEARING every existing
  // line first — so merely opening a top-up product page destroyed whatever the
  // visitor had been shopping for. The behaviour that test used to assert
  // ("clears any existing cart line before adding the selected denomination")
  // must no longer exist at all, in either direction: no read, no write, no
  // cart-based checkout summary, under ANY interaction on this page.
  it("never calls any cart endpoint — not on load, denomination switch, voucher apply, or submit", async () => {
    renderInstantBuy();
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
    await screen.findByText("Summary");
    expect(cartCalls()).toEqual([]);

    // Denomination switch.
    fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/preview", { denomination_id: 2, qty: 1 }),
    );
    expect(cartCalls()).toEqual([]);

    // Voucher apply.
    await screen.findByPlaceholderText("Code");
    fireEvent.change(screen.getByPlaceholderText("Code"), { target: { value: "SAVE10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/preview", {
        denomination_id: 2,
        qty: 1,
        voucher_code: "SAVE10",
      }),
    );
    expect(cartCalls()).toEqual([]);

    // Submit.
    const basePost = (apiPost as Mock).getMockImplementation()!;
    (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>) => {
      if (path === "/api/v1/topup/order") return { order_code: "ORD1", pay_url: "/checkout/ORD1/pay" };
      return basePost(path, body);
    });
    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
    fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Buy now/ })[0]).not.toBeDisabled());
    fireEvent.click(screen.getAllByRole("button", { name: /Buy now/ })[0]!);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/order", expect.any(Object), expect.objectContaining({ idempotencyKey: expect.any(String) })));

    expect(cartCalls()).toEqual([]);
  });

  // Batch 2 review finding: the preview query's own request never carries the
  // applied voucher code (previewMutation, a separate call, owns that
  // re-price) — with React Query's default staleTime:0, a background
  // window-focus refetch of the SAME (voucher-less) query would silently
  // reprice `totals` back to the undiscounted total while the order actually
  // submitted still carries the voucher code, exactly the kind of
  // preview-vs-charge divergence this whole feature exists to prevent.
  // staleTime: Infinity on that query is the fix under test here.
  it("keeps a voucher's discount on screen across a window-focus refetch", async () => {
    renderInstantBuy({
      // A voucher code in the body re-prices with a discount; the plain
      // denomination preview (what a stray background refetch would send)
      // stays full price — reproduces the bug's exact shape.
      preview: (body) =>
        body.voucher_code
          ? { ...checkoutData, total: "18000", voucher_discount: "2000", voucher_code: body.voucher_code as string }
          : checkoutData,
    });
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
    await screen.findByText("Summary");

    fireEvent.change(screen.getByPlaceholderText("Code"), { target: { value: "SAVE10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("Voucher");
    const callsAfterVoucher = (apiPost as Mock).mock.calls.length;

    // Simulate the buyer alt-tabbing away (e.g. to copy their in-game id)
    // and back — the standard way to trigger React Query's window-focus
    // refetch machinery deterministically in a test.
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No new request fired at all — staleTime: Infinity means the preview
    // query is never eligible for a background refetch — so there is no
    // voucher-less response that could have clobbered the discount.
    expect((apiPost as Mock).mock.calls.length).toBe(callsAfterVoucher);
    expect(screen.getByText("Voucher")).toBeInTheDocument();
  });

  it("routes to the pay page on a successful submit (signed-in buyer, client-side navigation)", async () => {
    renderInstantBuy();
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
    await screen.findByText("Summary");

    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
    fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });

    (apiPost as Mock).mockImplementation(async (path: string) => {
      if (path === "/api/v1/topup/order") return { order_code: "ORD1", pay_url: "/checkout/ORD1/pay" };
      return checkoutData;
    });

    fireEvent.click(screen.getByRole("button", { name: /Buy now/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/order", {
        denomination_id: 1,
        qty: 1,
        method: "binance",
        voucher_code: "",
        customer_data: [{ user_id: "1234567", zone_id: "1111" }],
        guest_email: undefined,
      }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
    );
    expect(await screen.findByText("pay-page-stub")).toBeInTheDocument();
  });

  it("holds the submit button back until the account field(s) are filled", async () => {
    renderInstantBuy();
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
    await screen.findByText("Summary");
    const buyButtons = screen.getAllByRole("button", { name: /Buy now/ });
    expect(buyButtons[0]).toBeDisabled();

    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
    fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Buy now/ })[0]).not.toBeDisabled());
  });

  it("never renders a cart or checkout page for this flow — success stays on a pay-page route", async () => {
    renderInstantBuy();
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
    expect(screen.queryByText("cart-page-stub")).not.toBeInTheDocument();
    expect(screen.queryByText("checkout-page-stub")).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/cart"]')).toBeNull();
  });

  // Code review finding I-3 (and its widening to the voucher trigger): a
  // re-price can leave `method` pointing at a payment row the new totals no
  // longer offer. Both triggers now re-validate it. The sibling finding I-2
  // (serializing the cart sync so two overlapping read/remove/add sequences
  // could not race) has no equivalent any more and is deliberately not
  // re-tested: the cart mutations it protected are gone, and a preview is a
  // pure read whose response React Query only surfaces for the currently
  // selected denomination.
  describe("method re-validation on re-price (I-3)", () => {
    it("lets the buyer switch denomination again while a preview is still in flight", async () => {
      renderInstantBuy();
      await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
      await screen.findByText("Summary");

      // Stall the 172-Diamonds preview so there is a window in which a second
      // pick lands mid-flight — it must be honoured, not dropped (the old
      // design had to drop it to protect a multi-step cart mutation).
      const basePost = (apiPost as Mock).getMockImplementation()!;
      let releaseStalled: (() => void) | null = null;
      let stalledStartedResolve: (() => void) | null = null;
      const stalledStarted = new Promise<void>((resolve) => {
        stalledStartedResolve = resolve;
      });
      (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>) => {
        if (path === "/api/v1/topup/preview" && (body as { denomination_id?: number }).denomination_id === 2) {
          stalledStartedResolve!();
          await new Promise<void>((resolve) => {
            releaseStalled = resolve;
          });
        }
        return basePost(path, body);
      });

      fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));
      await stalledStarted;
      fireEvent.click(screen.getByRole("radio", { name: /86 Diamonds/ }));

      expect((screen.getByRole("radio", { name: /86 Diamonds/ }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole("radio", { name: /172 Diamonds/ }) as HTMLInputElement).checked).toBe(false);

      releaseStalled!();
      await waitFor(() => expect(screen.getByText("Summary")).toBeInTheDocument());
      expect(cartCalls()).toEqual([]);
    });

    it("blocks submit while the live preview is in a failed state, and shows the error", async () => {
      renderInstantBuy();
      await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
      await screen.findByText("Summary");
      fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
      fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });
      await waitFor(() => expect(screen.getAllByRole("button", { name: /Buy now/ })[0]).not.toBeDisabled());

      (apiPost as Mock).mockImplementation(async () => {
        throw new Error("boom");
      });
      fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));

      expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
      expect(screen.getByLabelText("User ID")).toHaveValue("1234567");
      expect(screen.getByLabelText("Zone ID")).toHaveValue("1111");
      expect(screen.getAllByRole("button", { name: /Buy now/ })[0]).toBeDisabled();
    });

    it("clears a wallet-credit selection made for a cheaper denomination once switching to one the wallet no longer covers", async () => {
      // id1 costs 20000, id2 costs 38000; the wallet holds 25000.
      renderInstantBuy({
        preview: (body) => {
          const denominationId = (body.denomination_id as number | undefined) ?? 1;
          return {
            ...checkoutData,
            wallet_idr: "25000", // covers 20000, not 38000
            binance_enabled: true,
            total: denominationId === 2 ? "38000" : "20000",
            items: [
              {
                denomination_id: denominationId,
                delivery_type: "manual_with_info",
                additional_fields: productData.denominations[0]!.additional_fields,
                qty: 1,
              },
            ],
          };
        },
      });

      await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
      await screen.findByText("Summary");
      // Default selection is the enabled gateway, not wallet credit.
      expect((screen.getByRole("radio", { name: /BINANCE/ }) as HTMLInputElement).checked).toBe(true);

      // Buyer explicitly opts into wallet credit — sufficient for the cheap denomination.
      const walletRadio = screen.getByRole("radio", { name: /Wallet Credit \(IDR\)/ }) as HTMLInputElement;
      fireEvent.click(walletRadio);
      expect(walletRadio.checked).toBe(true);

      // Switch to the pricier denomination — the wallet balance no longer covers it.
      fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));
      await waitFor(() => expect(screen.queryByText("Wallet Credit (IDR)")).not.toBeInTheDocument());

      // No PAYMENT-METHOD radio is left checked (the denomination grid has
      // its own, separate radio group, always with exactly one checked, so
      // it's excluded here) — `method` was cleared rather than left pointing
      // at a row nothing renders any more.
      const methodRadios = screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).name === "method") as HTMLInputElement[];
      expect(methodRadios.some((r) => r.checked)).toBe(false);

      // Fill the info fields for the new denomination, so the only
      // remaining blocker is the missing method — proving the submit button
      // is NOT left "enabled" with the stale wallet_idr selection.
      fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
      fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });
      expect(screen.getAllByRole("button", { name: /Buy now/ })[0]).toBeDisabled();

      // Picking the still-available gateway explicitly re-enables it.
      fireEvent.click(screen.getByRole("radio", { name: /BINANCE/ }));
      expect(screen.getAllByRole("button", { name: /Buy now/ })[0]).not.toBeDisabled();
    });

    // Re-review of I-3: the denomination-switch fix only re-runs off the
    // preview query's data. The voucher-apply path (previewMutation) calls
    // setTotals(resp) directly, so a voucher re-application that raises the
    // total back past the wallet balance used to leave `method` pointed at
    // "wallet_idr" even though PaymentMethodSelector (which renders off the
    // live `totals`) no longer shows that row — the same stale-method bug
    // class, just via a different trigger. Now covered by previewMutation's
    // own onSuccess.
    it("clears a wallet-credit selection when a voucher re-application raises the total back past the wallet balance", async () => {
      const walletCoveredCheckout: CheckoutData = {
        ...checkoutData, // denomination id1, total 20000
        wallet_idr: "25000", // covers 20000, not the 30000 the voucher below re-prices to
        binance_enabled: true,
      };
      renderInstantBuy({
        // A voucher code in the body re-prices to 30000; the plain
        // denomination preview stays at 20000.
        preview: (body) =>
          body.voucher_code
            ? { ...walletCoveredCheckout, total: "30000", voucher_discount: "0", voucher_code: body.voucher_code as string }
            : walletCoveredCheckout,
      });
      await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
      await screen.findByText("Summary");

      // Default selection is the enabled gateway, not wallet credit.
      expect((screen.getByRole("radio", { name: /BINANCE/ }) as HTMLInputElement).checked).toBe(true);

      // Buyer explicitly opts into wallet credit — sufficient for the current (20000) total.
      const walletRadio = screen.getByRole("radio", { name: /Wallet Credit \(IDR\)/ }) as HTMLInputElement;
      fireEvent.click(walletRadio);
      expect(walletRadio.checked).toBe(true);

      fireEvent.change(screen.getByPlaceholderText("Code"), { target: { value: "SMALLER10" } });
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));

      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/preview", {
          denomination_id: 1,
          qty: 1,
          voucher_code: "SMALLER10",
        }),
      );
      await waitFor(() => expect(screen.queryByText("Wallet Credit (IDR)")).not.toBeInTheDocument());

      // No PAYMENT-METHOD radio is left checked — `method` was cleared rather
      // than left pointing at a row nothing renders any more.
      const methodRadios = screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).name === "method") as HTMLInputElement[];
      expect(methodRadios.some((r) => r.checked)).toBe(false);

      // Fill the account fields so the only remaining blocker is the missing method.
      fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
      fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });
      expect(screen.getAllByRole("button", { name: /Buy now/ })[0]).toBeDisabled();

      // Picking the still-available gateway explicitly re-enables it.
      fireEvent.click(screen.getByRole("radio", { name: /BINANCE/ }));
      expect(screen.getAllByRole("button", { name: /Buy now/ })[0]).not.toBeDisabled();
    });
  });

  // Task 7: the live KokinPay nickname-check lookup on the account field.
  // Fake timers drive the ~800ms debounce (same convention as web-admin's
  // SearchPage.test.tsx "debounces typed input" test: vi.useFakeTimers() +
  // vi.advanceTimersByTime + vi.waitFor, which polls with real time so
  // pending microtasks from the mocked apiPost still resolve).
  describe("live nickname check (Task 7)", () => {
    it("cancels the previous denomination lookup and rechecks preserved account answers", async () => {
      try {
        renderInstantBuy();
        await screen.findByText("Summary");
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        let releaseOld!: (result: { available: boolean; valid: boolean; nickname: string }) => void;
        (apiPost as Mock).mockImplementation((path: string, body: Record<string, unknown>) => {
          if (path === "/api/v1/topup/check-account") {
            if (body.denomination_id === 1) return new Promise((resolve) => { releaseOld = resolve; });
            return Promise.resolve({ available: true, valid: true, nickname: "CurrentAccount" });
          }
          return baseApiPost(path, body);
        });
        vi.useFakeTimers();
        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "0012" } });
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        const firstLookup = (apiPost as Mock).mock.calls.find((call) => call[0] === "/api/v1/topup/check-account")!;
        const firstSignal = (firstLookup[2] as { signal: AbortSignal }).signal;

        fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));
        expect(firstSignal.aborted).toBe(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        expect(apiPost).toHaveBeenCalledWith("/api/v1/topup/check-account", {
          denomination_id: 2, player_inputs: { user_id: "1234567", zone_id: "0012" },
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        await act(async () => { releaseOld({ available: true, valid: true, nickname: "StaleAccount" }); });
        expect(screen.getByTestId("nickname-check-found")).toHaveTextContent("CurrentAccount");
        expect(screen.queryByText(/StaleAccount/)).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("fires the debounced check-account lookup ~800ms after the account field stops changing, sending all configured fields", async () => {
      try {
        renderInstantBuy();
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path === "/api/v1/topup/check-account") return { available: false };
          return baseApiPost(path, body, signal);
        });

        await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
        await screen.findByText("Summary");
        vi.useFakeTimers();

        fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1234" } });
        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        // Not fired yet — still inside the debounce window.
        expect((apiPost as Mock).mock.calls.some((c) => c[0] === "/api/v1/topup/check-account")).toBe(false);

        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        await vi.waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith(
            "/api/v1/topup/check-account",
            { denomination_id: 1, player_inputs: { user_id: "1234567", zone_id: "1234" } },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          ),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels the in-flight lookup via AbortController when the account field changes again before it resolves", async () => {
      try {
        renderInstantBuy();
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path === "/api/v1/topup/check-account") {
            // Never resolves within this test — the point is to inspect the
            // signal passed alongside this still-pending call, not its result.
            return new Promise(() => {});
          }
          return baseApiPost(path, body, signal);
        });

        await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
        await screen.findByText("Summary");
        vi.useFakeTimers();

        fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1234" } });
        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1111" } });
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        await vi.waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith(
            "/api/v1/topup/check-account",
            { denomination_id: 1, player_inputs: { user_id: "1111", zone_id: "1234" } },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          ),
        );
        const firstCall = (apiPost as Mock).mock.calls.find(
          (c) => c[0] === "/api/v1/topup/check-account" && ((c[1] as { player_inputs: Record<string, string> }).player_inputs).user_id === "1111",
        )!;
        const firstSignal = (firstCall[2] as { signal: AbortSignal }).signal;
        expect(firstSignal.aborted).toBe(false);

        // The field changes again before the first lookup resolves — its
        // request must be cancelled (not just superseded).
        fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1234" } });
        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "2222" } });
        expect(firstSignal.aborted).toBe(true);

        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        await vi.waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith(
            "/api/v1/topup/check-account",
            { denomination_id: 1, player_inputs: { user_id: "2222", zone_id: "1234" } },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          ),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders the resolved nickname once the debounced lookup resolves with a match", async () => {
      try {
        renderInstantBuy();
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path === "/api/v1/topup/check-account") return { available: true, valid: true, nickname: "ProGamer99" };
          return baseApiPost(path, body, signal);
        });

        await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
        await screen.findByText("Summary");
        vi.useFakeTimers();

        fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1234" } });
        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });

        await vi.waitFor(() => expect(screen.getByText("✓ ProGamer99")).toBeInTheDocument());
      } finally {
        vi.useRealTimers();
      }
    });

    // Code review finding: firing the lookup on any non-empty id, with no
    // regard for a server/zone field the denomination's own template
    // requires, produced a premature "not found" hint on a CORRECT id (e.g.
    // Mobile Legends) while the buyer had merely not yet typed the zone.
    it("does not fire the lookup when the account id is filled but a server_id field from this denomination's own template is still empty", async () => {
      try {
        const product: ProductPageData = {
          ...productData,
          denominations: [
            {
              ...productData.denominations[0]!,
              additional_fields: [
                { key: "user_id", label: { id: "ID Pengguna", en: "User ID" }, type: "text", required: true, options: [], placeholder: "123456789" },
                { key: "server_id", label: { id: "Server", en: "Server" }, type: "text", required: true, options: [], placeholder: "1234" },
              ],
            },
          ],
        };
        renderInstantBuy({ product });
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path === "/api/v1/topup/check-account") return { available: false };
          return baseApiPost(path, body, signal);
        });

        await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
        await screen.findByText("Summary");
        vi.useFakeTimers();

        // Account id only — the server/zone field is left empty.
        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });

        expect((apiPost as Mock).mock.calls.some((c) => c[0] === "/api/v1/topup/check-account")).toBe(false);

        // Filling the server field too now lets the (debounced) lookup fire.
        fireEvent.change(screen.getByLabelText("Server"), { target: { value: "1111" } });
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        await vi.waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith(
            "/api/v1/topup/check-account",
            { denomination_id: 1, player_inputs: { user_id: "1234567", server_id: "1111" } },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          ),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows nothing at all when the endpoint degrades to available:false — the field behaves exactly as it does today", async () => {
      try {
        renderInstantBuy();
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path === "/api/v1/topup/check-account") return { available: false };
          return baseApiPost(path, body, signal);
        });

        await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
        await screen.findByText("Summary");
        vi.useFakeTimers();

        fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1234" } });
        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        await vi.waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith(
            "/api/v1/topup/check-account",
            { denomination_id: 1, player_inputs: { user_id: "1234567", zone_id: "1234" } },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          ),
        );

        // The lookup resolves asynchronously after the call above lands —
        // wait for the pending indicator to clear before asserting the
        // final (silent) state.
        await vi.waitFor(() => expect(screen.queryByTestId("nickname-check-pending")).not.toBeInTheDocument());
        expect(screen.queryByTestId("nickname-check-found")).not.toBeInTheDocument();
        expect(screen.queryByTestId("nickname-check-not-found")).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Final-review fix: a USD-display viewer on an IDR-settlement rail
  // (QRIS/PayDisini) sees the Rp payable next to the $ figure in the sticky
  // bar, like the bot's payAlongsidePriceLine. fx 16000: qris_grand_total
  // 20240 → $1.27, total 20000 → $1.25.
  describe("sticky bar Price · Pay line for a USD viewer", () => {
    const usdContext: ShopContext = { ...context, currency: "USD" };
    const bar = () => {
      act(() => NoOpIntersectionObserver.primaryCallback?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
      return document.querySelector(".fixed.bottom-0");
    };

    it("QRIS: shows the $ total and the Rp payable the rail will charge", async () => {
      renderInstantBuy({ checkout: { ...checkoutData, idr_enabled: true }, ctx: usdContext });
      await screen.findByText("Summary");
      await waitFor(() => expect(bar()).toHaveTextContent("Price $1.25 · Pay Rp20,240"));
    });

    it("PayDisini: the Rp payable is the fee-free total", async () => {
      renderInstantBuy({ checkout: { ...checkoutData, paydisini_enabled: true }, ctx: usdContext });
      await screen.findByText("Summary");
      await waitFor(() => expect(bar()).toHaveTextContent("Price $1.25 · Pay Rp20,000"));
    });

    it("USDT rail (binance default): no dual line", async () => {
      renderInstantBuy({ ctx: usdContext });
      await screen.findByText("Summary");
      await waitFor(() => expect(bar()).toHaveTextContent("$1.25"));
      expect(bar()).not.toHaveTextContent("Pay Rp");
    });

    it("QRIS for an IDR viewer: unchanged, Rp only", async () => {
      renderInstantBuy({ checkout: { ...checkoutData, idr_enabled: true }, ctx: { ...context, currency: "IDR" } });
      await screen.findByText("Summary");
      await waitFor(() => expect(bar()).toHaveTextContent("Rp20,240"));
      expect(bar()).not.toHaveTextContent("Pay Rp");
      expect(bar()).not.toHaveTextContent("$");
    });

    it("QRIS for a null-preference viewer: unchanged, no dual line", async () => {
      renderInstantBuy({ checkout: { ...checkoutData, idr_enabled: true } });
      await screen.findByText("Summary");
      await waitFor(() => expect(bar()).toHaveTextContent("Rp20,240"));
      expect(bar()).not.toHaveTextContent("Pay Rp");
    });
  });

  // Fase 12: product.icon_kind is resolved once server-side and forwarded to
  // every DenominationCard as `iconKind` — same contract ProductPage.tsx
  // follows for its own (catalog-flow) denom-list.
  describe("currency-icon chip (Fase 12)", () => {
    it("forwards product.icon_kind to every DenominationCard as the currency chip", async () => {
      const withIcon: ProductPageData = {
        ...productData,
        product: { ...productData.product, icon_kind: "diamond" },
      };
      renderInstantBuy({ product: withIcon });
      const heading = await screen.findByRole("heading", { name: "Choose a plan" });
      const denomList = heading.nextElementSibling as HTMLElement;
      expect(denomList.querySelectorAll(".lucide-gem")).toHaveLength(productData.denominations.length);
    });

    it("renders no currency chip on any DenominationCard when product.icon_kind is null", async () => {
      const noIcon: ProductPageData = {
        ...productData,
        product: { ...productData.product, icon_kind: null },
      };
      renderInstantBuy({ product: noIcon });
      const heading = await screen.findByRole("heading", { name: "Choose a plan" });
      const denomList = heading.nextElementSibling as HTMLElement;
      expect(denomList.querySelectorAll("label.denom-card svg")).toHaveLength(0);
    });
  });
});
