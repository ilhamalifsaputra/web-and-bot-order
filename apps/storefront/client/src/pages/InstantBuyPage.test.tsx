import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import InstantBuyPage from "./InstantBuyPage";
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
  observe() {}
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
  } = {},
) {
  const product = options.product ?? productData;
  const checkout = options.checkout ?? checkoutData;
  const slug = options.slug ?? product.product.slug;
  const emptyCart: CartPageData = { items: [], subtotal: "0" };

  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
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
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/p/${slug}`]}>
        <Routes>
          <Route path="/p/:slug" element={<InstantBuyPage />} />
          <Route path="/checkout/:code/pay" element={<div>pay-page-stub</div>} />
          <Route path="/login" element={<div>login-page-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("InstantBuyPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
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
      // Re-fill the (reset) info fields for the newly-selected denomination —
      // isolates the assertion below to the failed-preview gate, not the info step.
      fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
      fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });
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

      // Fill the (reset) info fields for the new denomination, so the only
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
    it("fires the debounced check-account lookup ~800ms after the account field stops changing, mapping user_id -> id", async () => {
      vi.useFakeTimers();
      try {
        renderInstantBuy();
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path === "/api/v1/topup/check-account") return { available: false };
          return baseApiPost(path, body, signal);
        });

        await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Mobile Legends Diamonds" })).toBeInTheDocument());
        await vi.waitFor(() => expect(screen.getByText("Summary")).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        // Not fired yet — still inside the debounce window.
        expect((apiPost as Mock).mock.calls.some((c) => c[0] === "/api/v1/topup/check-account")).toBe(false);

        vi.advanceTimersByTime(800);
        await vi.waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith(
            "/api/v1/topup/check-account",
            { denomination_id: 1, id: "1234567", server: undefined },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          ),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels the in-flight lookup via AbortController when the account field changes again before it resolves", async () => {
      vi.useFakeTimers();
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

        await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Mobile Legends Diamonds" })).toBeInTheDocument());
        await vi.waitFor(() => expect(screen.getByText("Summary")).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1111" } });
        vi.advanceTimersByTime(800);
        await vi.waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith(
            "/api/v1/topup/check-account",
            { denomination_id: 1, id: "1111", server: undefined },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          ),
        );
        const firstCall = (apiPost as Mock).mock.calls.find(
          (c) => c[0] === "/api/v1/topup/check-account" && (c[1] as Record<string, unknown>).id === "1111",
        )!;
        const firstSignal = (firstCall[2] as { signal: AbortSignal }).signal;
        expect(firstSignal.aborted).toBe(false);

        // The field changes again before the first lookup resolves — its
        // request must be cancelled (not just superseded).
        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "2222" } });
        expect(firstSignal.aborted).toBe(true);

        vi.advanceTimersByTime(800);
        await vi.waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith(
            "/api/v1/topup/check-account",
            { denomination_id: 1, id: "2222", server: undefined },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          ),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders the resolved nickname once the debounced lookup resolves with a match", async () => {
      vi.useFakeTimers();
      try {
        renderInstantBuy();
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path === "/api/v1/topup/check-account") return { available: true, valid: true, nickname: "ProGamer99" };
          return baseApiPost(path, body, signal);
        });

        await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Mobile Legends Diamonds" })).toBeInTheDocument());
        await vi.waitFor(() => expect(screen.getByText("Summary")).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        vi.advanceTimersByTime(800);

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
      vi.useFakeTimers();
      try {
        const product: ProductPageData = {
          ...productData,
          denominations: [
            {
              ...productData.denominations[0]!,
              additional_fields: [
                { key: "user_id", label: { id: "ID Pengguna", en: "User ID" }, type: "text", required: true, options: [], placeholder: "123456789" },
                { key: "server_id", label: { id: "Server", en: "Server" }, type: "text", required: false, options: [], placeholder: "1234" },
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

        await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Mobile Legends Diamonds" })).toBeInTheDocument());
        await vi.waitFor(() => expect(screen.getByText("Summary")).toBeInTheDocument());

        // Account id only — the server/zone field is left empty.
        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        vi.advanceTimersByTime(800);
        vi.advanceTimersByTime(800);

        expect((apiPost as Mock).mock.calls.some((c) => c[0] === "/api/v1/topup/check-account")).toBe(false);

        // Filling the server field too now lets the (debounced) lookup fire.
        fireEvent.change(screen.getByLabelText("Server"), { target: { value: "1111" } });
        vi.advanceTimersByTime(800);
        await vi.waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith(
            "/api/v1/topup/check-account",
            { denomination_id: 1, id: "1234567", server: "1111" },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          ),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows nothing at all when the endpoint degrades to available:false — the field behaves exactly as it does today", async () => {
      vi.useFakeTimers();
      try {
        renderInstantBuy();
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path === "/api/v1/topup/check-account") return { available: false };
          return baseApiPost(path, body, signal);
        });

        await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Mobile Legends Diamonds" })).toBeInTheDocument());
        await vi.waitFor(() => expect(screen.getByText("Summary")).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        vi.advanceTimersByTime(800);
        await vi.waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith(
            "/api/v1/topup/check-account",
            { denomination_id: 1, id: "1234567", server: undefined },
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

  // Region-check Task C: the admin-authored `region_warning` callout and the
  // live `region_mismatch` hint, both riding InstantBuyPage's existing
  // account-field card. Neither signal may ever block or disable submit.
  describe("region-check (Task C)", () => {
    it("renders the admin-authored region_warning Callout when set on the selected denomination", async () => {
      const product: ProductPageData = {
        ...productData,
        denominations: [
          { ...productData.denominations[0]!, region_warning: "Only for Indonesia-region accounts." },
          productData.denominations[1]!,
        ],
      };
      renderInstantBuy({ product });
      await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
      expect(await screen.findByText("Only for Indonesia-region accounts.")).toBeInTheDocument();
    });

    it("renders nothing extra when region_warning is null/absent", async () => {
      renderInstantBuy();
      await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
      await screen.findByLabelText("User ID");
      expect(screen.queryByText("Only for Indonesia-region accounts.")).not.toBeInTheDocument();
    });

    it("renders the automatic mismatch hint when the check-account response signals region_mismatch: true, and never disables submit", async () => {
      vi.useFakeTimers();
      try {
        renderInstantBuy();
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path === "/api/v1/topup/check-account") {
            return { available: true, valid: true, nickname: "ProGamer99", region_mismatch: true };
          }
          return baseApiPost(path, body, signal);
        });

        await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Mobile Legends Diamonds" })).toBeInTheDocument());
        await vi.waitFor(() => expect(screen.getByText("Summary")).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });
        vi.advanceTimersByTime(800);

        await vi.waitFor(() => expect(screen.getByTestId("region-mismatch-hint")).toBeInTheDocument());
        expect(screen.getByText(/may be registered in a different region/i)).toBeInTheDocument();

        // Non-blocking: submit is still enabled once the account fields are
        // filled, exactly as without the mismatch hint — neither this signal
        // nor the KokinPay nickname match disables/hides the buy button.
        await vi.waitFor(() => expect(screen.getAllByRole("button", { name: /Buy now/ })[0]).not.toBeDisabled());
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not render the mismatch hint when region_mismatch is absent from the response", async () => {
      vi.useFakeTimers();
      try {
        renderInstantBuy();
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path === "/api/v1/topup/check-account") return { available: true, valid: true, nickname: "ProGamer99" };
          return baseApiPost(path, body, signal);
        });

        await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Mobile Legends Diamonds" })).toBeInTheDocument());
        await vi.waitFor(() => expect(screen.getByText("Summary")).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });
        vi.advanceTimersByTime(800);

        await vi.waitFor(() => expect(screen.getByText("✓ ProGamer99")).toBeInTheDocument());
        expect(screen.queryByTestId("region-mismatch-hint")).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("submitting the order is never blocked by region_warning or region_mismatch being present together", async () => {
      const product: ProductPageData = {
        ...productData,
        denominations: [
          { ...productData.denominations[0]!, region_warning: "Only for Indonesia-region accounts." },
          productData.denominations[1]!,
        ],
      };
      vi.useFakeTimers();
      try {
        renderInstantBuy({ product });
        const baseApiPost = (apiPost as Mock).getMockImplementation()!;
        (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path === "/api/v1/topup/check-account") {
            return { available: true, valid: true, nickname: "ProGamer99", region_mismatch: true };
          }
          if (path === "/api/v1/topup/order") return { order_code: "ORD1", pay_url: "/checkout/ORD1/pay" };
          return baseApiPost(path, body, signal);
        });

        await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Mobile Legends Diamonds" })).toBeInTheDocument());
        await vi.waitFor(() => expect(screen.getByText("Summary")).toBeInTheDocument());

        fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
        fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });
        vi.advanceTimersByTime(800);
        await vi.waitFor(() => expect(screen.getByTestId("region-mismatch-hint")).toBeInTheDocument());

        const buyButton = screen.getAllByRole("button", { name: /Buy now/ })[0]!;
        expect(buyButton).not.toBeDisabled();
        fireEvent.click(buyButton);
        await vi.waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith(
            "/api/v1/topup/order",
            expect.objectContaining({ method: "binance", denomination_id: 1, qty: 1 }),
            expect.objectContaining({ idempotencyKey: expect.any(String) }),
          ),
        );
      } finally {
        vi.useRealTimers();
      }
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
