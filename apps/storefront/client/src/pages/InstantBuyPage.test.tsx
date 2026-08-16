import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
};

/**
 * Simulates the real cart: `/api/v1/cart` POST/remove mutate an in-memory
 * line list that the checkout GET and the next cart GET both read, same as
 * the server does. `extraPost` lets an individual test intercept a specific
 * path (typically `/api/v1/checkout` for placing the order, or the voucher
 * preview) without having to reimplement the cart simulation.
 */
function renderInstantBuy(options: { product?: ProductPageData; checkout?: CheckoutData; slug?: string } = {}) {
  const product = options.product ?? productData;
  const checkout = options.checkout ?? checkoutData;
  const slug = options.slug ?? product.product.slug;
  let cart: CartPageData = { items: [], subtotal: "0" };
  let nextKey = 1;

  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    if (path === `/api/v1/pages/product/${slug}`) return product;
    if (path === "/api/v1/cart") return cart;
    if (path === "/api/v1/checkout") return checkout;
    throw new Error(`unexpected GET ${path}`);
  });

  (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>) => {
    if (path === "/api/v1/cart") {
      cart = {
        items: [
          {
            key: nextKey++,
            denomination_id: body.denomination_id as number,
            product_slug: slug,
            name: product.product.name,
            image: product.product.image,
            unit_price: "0",
            qty: body.qty as number,
            line_total: "0",
            available: 0,
            delivery_type: "manual_with_info",
          },
        ],
        subtotal: "0",
      };
      return cart;
    }
    if (path === "/api/v1/cart/remove") {
      cart = { items: cart.items.filter((i) => i.key !== body.key), subtotal: "0" };
      return cart;
    }
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

  it("syncs the cart to the default denomination on load, then re-syncs when another is picked", async () => {
    renderInstantBuy();
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/cart", { denomination_id: 1, qty: 1 }),
    );
    // The live totals card only renders once the post-sync checkout GET lands.
    expect(await screen.findByText("Summary")).toBeInTheDocument();

    (apiPost as Mock).mockClear();
    fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/cart", { denomination_id: 2, qty: 1 }),
    );
  });

  it("clears any existing cart line before adding the selected denomination (never relies on the server's same-line qty-increment path)", async () => {
    // Cart already holds an unrelated line from earlier browsing — the sync
    // must remove it before (re-)adding the instant-buy denomination, so the
    // order this page places is always exactly qty 1 of exactly one line.
    const product = productData;
    let cart: CartPageData = {
      items: [
        {
          key: 99,
          denomination_id: 42,
          product_slug: "other-product",
          name: "Other",
          image: "",
          unit_price: "10000",
          qty: 3,
          line_total: "30000",
          available: 5,
          delivery_type: "auto",
        },
      ],
      subtotal: "30000",
    };
    (apiGet as Mock).mockImplementation(async (path: string) => {
      if (path === "/api/v1/pages/context") return context;
      if (path === `/api/v1/pages/product/${product.product.slug}`) return product;
      if (path === "/api/v1/cart") return cart;
      if (path === "/api/v1/checkout") return checkoutData;
      throw new Error(`unexpected GET ${path}`);
    });
    (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>) => {
      if (path === "/api/v1/cart/remove") {
        cart = { items: cart.items.filter((i) => i.key !== body.key), subtotal: "0" };
        return cart;
      }
      if (path === "/api/v1/cart") {
        cart = { items: [{ ...cart.items[0]!, key: 100, denomination_id: body.denomination_id as number, qty: 1 }], subtotal: "0" };
        return cart;
      }
      throw new Error(`unexpected POST ${path}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/p/${product.product.slug}`]}>
          <Routes>
            <Route path="/p/:slug" element={<InstantBuyPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/cart/remove", { key: 99 }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/cart", { denomination_id: 1, qty: 1 }));
  });

  it("routes to the pay page on a successful submit (signed-in buyer, client-side navigation)", async () => {
    renderInstantBuy();
    await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
    await screen.findByText("Summary");

    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
    fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });

    (apiPost as Mock).mockImplementation(async (path: string) => {
      if (path === "/api/v1/checkout") return { order_code: "ORD1", pay_url: "/checkout/ORD1/pay" };
      return { items: [], subtotal: "0" };
    });

    fireEvent.click(screen.getByRole("button", { name: /Buy now/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout", {
        method: "binance",
        voucher_code: "",
        customer_data: [{ user_id: "1234567", zone_id: "1111" }],
        guest_email: undefined,
      }),
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

  // Code review findings I-2/I-3: the cart-sync effect (fired off the
  // selected denomination's id — read cart, remove old lines, add new line)
  // had no serialization, and a stale wallet-credit selection wasn't
  // re-validated after a re-price. Both are fixed in the same place: the
  // denomination grid's onChange now ignores a pick while syncCart.isPending,
  // and the checkoutData effect clears `method` when it's no longer a valid
  // row for the fresh totals.
  describe("cart-sync serialization and method re-validation (I-2 / I-3)", () => {
    it("ignores a rapid second denomination pick while the first sync is still in flight", async () => {
      renderInstantBuy();
      await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
      await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/cart", { denomination_id: 1, qty: 1 }));
      await screen.findByText("Summary");

      // Stall the cart-read the 172-Diamonds sync issues, so we have a
      // window to click again while that sync is still pending — a second,
      // overlapping sync must never start while the first is in flight.
      const baseGet = (apiGet as Mock).getMockImplementation()!;
      let cartReads = 0;
      let releaseStalledRead: (() => void) | null = null;
      let stalledReadStartedResolve: (() => void) | null = null;
      const stalledReadStarted = new Promise<void>((resolve) => {
        stalledReadStartedResolve = resolve;
      });
      (apiGet as Mock).mockImplementation(async (path: string) => {
        if (path === "/api/v1/cart") {
          cartReads += 1;
          if (cartReads === 1) {
            stalledReadStartedResolve!();
            await new Promise<void>((resolve) => {
              releaseStalledRead = resolve;
            });
          }
        }
        return baseGet(path);
      });

      fireEvent.click(screen.getByRole("radio", { name: /172 Diamonds/ }));
      await stalledReadStarted;
      // Rapid second pick, while the 172-Diamonds sync is stalled mid-flight —
      // must be dropped, not start a second overlapping sync sequence.
      fireEvent.click(screen.getByRole("radio", { name: /86 Diamonds/ }));

      expect((screen.getByRole("radio", { name: /172 Diamonds/ }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole("radio", { name: /86 Diamonds/ }) as HTMLInputElement).checked).toBe(false);

      releaseStalledRead!();
      await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/cart", { denomination_id: 2, qty: 1 }));
      // Only the original default-pick add call for denomination 1 exists —
      // the ignored second click never issued its own add call for it.
      expect(
        (apiPost as Mock).mock.calls.filter(
          (c) => c[0] === "/api/v1/cart" && (c[1] as { denomination_id?: number })?.denomination_id === 1,
        ),
      ).toHaveLength(1);
    });

    it("blocks submit while the cart sync is in a failed state, and shows the error", async () => {
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
      // isolates the assertion below to the sync-failure gate, not the info step.
      fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "1234567" } });
      fireEvent.change(screen.getByLabelText("Zone ID"), { target: { value: "1111" } });
      expect(screen.getAllByRole("button", { name: /Buy now/ })[0]).toBeDisabled();
    });

    it("clears a wallet-credit selection made for a cheaper denomination once switching to one the wallet no longer covers", async () => {
      const product = productData; // id1 20000, id2 38000
      let cart: CartPageData = { items: [], subtotal: "0" };
      let nextKey = 1;

      function checkoutFor(current: CartPageData): CheckoutData {
        const denominationId = (current.items[0]?.denomination_id as number | undefined) ?? 1;
        const total = denominationId === 2 ? "38000" : "20000";
        return {
          ...checkoutData,
          wallet_idr: "25000", // covers 20000, not 38000
          binance_enabled: true,
          total,
          items: [
            {
              denomination_id: denominationId,
              delivery_type: "manual_with_info",
              additional_fields: product.denominations[0]!.additional_fields,
              qty: 1,
            },
          ],
        };
      }

      (apiGet as Mock).mockImplementation(async (path: string) => {
        if (path === "/api/v1/pages/context") return context;
        if (path === `/api/v1/pages/product/${product.product.slug}`) return product;
        if (path === "/api/v1/cart") return cart;
        if (path === "/api/v1/checkout") return checkoutFor(cart);
        throw new Error(`unexpected GET ${path}`);
      });
      (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>) => {
        if (path === "/api/v1/cart") {
          cart = {
            items: [
              {
                key: nextKey++,
                denomination_id: body.denomination_id as number,
                product_slug: product.product.slug,
                name: product.product.name,
                image: product.product.image,
                unit_price: "0",
                qty: body.qty as number,
                line_total: "0",
                available: 0,
                delivery_type: "manual_with_info",
              },
            ],
            subtotal: "0",
          };
          return cart;
        }
        if (path === "/api/v1/cart/remove") {
          cart = { items: cart.items.filter((i) => i.key !== body.key), subtotal: "0" };
          return cart;
        }
        throw new Error(`unexpected POST ${path}`);
      });

      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/p/${product.product.slug}`]}>
            <Routes>
              <Route path="/p/:slug" element={<InstantBuyPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

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

    // Re-review of I-3: the fix above only re-runs off `checkoutData`, which
    // only changes via a denomination switch (syncCart's onSuccess). The
    // voucher-apply path (previewMutation) calls setTotals(resp) directly and
    // never touches checkoutData, so a voucher re-application that raises the
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
      renderInstantBuy({ checkout: walletCoveredCheckout });
      await screen.findByRole("heading", { name: "Mobile Legends Diamonds" });
      await screen.findByText("Summary");

      // Default selection is the enabled gateway, not wallet credit.
      expect((screen.getByRole("radio", { name: /BINANCE/ }) as HTMLInputElement).checked).toBe(true);

      // Buyer explicitly opts into wallet credit — sufficient for the current (20000) total.
      const walletRadio = screen.getByRole("radio", { name: /Wallet Credit \(IDR\)/ }) as HTMLInputElement;
      fireEvent.click(walletRadio);
      expect(walletRadio.checked).toBe(true);

      // Apply a voucher whose preview re-prices the order back past the wallet
      // balance (e.g. swapping in a smaller-discount code) — `checkoutData`
      // itself is untouched here, isolating this to previewMutation's onSuccess.
      const baseApiPost = (apiPost as Mock).getMockImplementation()!;
      (apiPost as Mock).mockImplementation(async (path: string, body: Record<string, unknown>) => {
        if (path === "/api/v1/checkout/voucher/preview") {
          return { ...walletCoveredCheckout, total: "30000", voucher_discount: "0", voucher_code: body.voucher_code as string };
        }
        return baseApiPost(path, body);
      });

      fireEvent.change(screen.getByPlaceholderText("Code"), { target: { value: "SMALLER10" } });
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));

      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout/voucher/preview", { voucher_code: "SMALLER10" }),
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
});
