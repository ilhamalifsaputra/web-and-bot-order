import "@testing-library/jest-dom";
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CheckoutPage from "./CheckoutPage";
import { apiGet, apiPost } from "../api/client";
import { readCodeEmailed } from "../lib/orderCodeEmailed";
import type { AdditionalField, CheckoutData, PlaceOrderResponse, ShopContext } from "../api/types";
import type { CanonicalProduct } from "../api/canonical";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const context: ShopContext = {
  lang: "en",
  fx: "16000",
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 1,
  customer: { username: "alice", email: null, telegram_linked: false },
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  wa_number: null,
  tzname: "Asia/Jakarta",
  currency: null,
};

const checkoutData: CheckoutData = {
  items_empty: false,
  items: [{ denomination_id: 1, delivery_type: "auto", additional_fields: [], qty: 1 }],
  subtotal: "158000",
  bulk_discount: "0",
  voucher_discount: "0",
  total: "158000",
  qris_admin_fee: "1206", // 100 + 0.70% of 158000
  qris_grand_total: "159206",
  total_usdt: "9.88",
  voucher_code: "",
  error_key: null,
  binance_enabled: true,
  bybit_enabled: false,
  bybit_bsc_enabled: false,
  idr_enabled: false, // fixture: idr disabled, binance enabled -> binance is the default
  paydisini_enabled: false,
  nowpayments_enabled: false,
  wallet_idr: "0",
  wallet_usdt: "0",
  // Signed-in buyer by default; the guest block below overrides all three.
  wallet_idr_enabled: true,
  wallet_usdt_enabled: true,
  is_guest: false,
  below_all_minimums: false,
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

function renderCheckout(respond: (path: string) => unknown, ctx: ShopContext = context) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return ctx;
    return respond(path);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/checkout"]}>
        <Routes>
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/checkout/:code/pay" element={<div>pay-page-stub</div>} />
          <Route path="/account/orders/:code" element={<div>order-detail-stub</div>} />
          <Route path="/cart" element={<div>cart-page-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe("CheckoutPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders totals and the summary card", async () => {
    renderCheckout(() => checkoutData);
    expect(await screen.findByRole("heading", { name: "Checkout" })).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getAllByText("Rp158,000").length).toBeGreaterThan(0);
  });

  it("identifies two different parent products with the same canonical plan name", async () => {
    const items = [
      { ...checkoutData.items[0]!, denomination_id: 1, canonical: canonicalMonth(1, "Netflix Premium") },
      { ...checkoutData.items[0]!, denomination_id: 2, canonical: canonicalMonth(2, "Spotify Premium") },
    ];
    renderCheckout(() => ({ ...checkoutData, items }));
    expect(await screen.findByText("Netflix Premium · 1 Month")).toBeInTheDocument();
    expect(screen.getByText("Spotify Premium · 1 Month")).toBeInTheDocument();
  });

  it("shows an identical canonical parent and variant once while keeping qualifiers", async () => {
    const canonical: CanonicalProduct = {
      ...canonicalMonth(1, "Netflix Premium"), displayName: "Netflix Premium",
      variant: { type: "unknown", name: "Netflix Premium", residual: [] }, qualifiers: ["Indonesia"],
    };
    renderCheckout(() => ({ ...checkoutData, items: [{ ...checkoutData.items[0]!, canonical }] }));
    expect(await screen.findByText("Netflix Premium · Indonesia")).toBeInTheDocument();
    expect(screen.queryByText("Netflix Premium · Netflix Premium · Indonesia")).not.toBeInTheDocument();
  });

  it("defaults the method radio to the first enabled method (idr disabled, binance enabled)", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    const binanceRadio = screen.getByRole("radio", { name: /BINANCE/ }) as HTMLInputElement;
    expect(binanceRadio.checked).toBe(true);
    // QRIS (idr) is disabled in this fixture -> not rendered at all.
    expect(screen.queryByRole("radio", { name: /QRIS/ })).not.toBeInTheDocument();
    // No QRIS admin fee line either — it's method-specific.
    expect(screen.queryByText("QRIS admin fee")).not.toBeInTheDocument();
  });

  // QRIS admin fee (Rp100 + 0.70%): shown once QRIS is the selected method,
  // both as a summary line and folded into the displayed grand total — not
  // shown for any other payment method.
  it("shows the QRIS admin fee breakdown and grand total when QRIS is selected", async () => {
    renderCheckout(() => ({ ...checkoutData, idr_enabled: true }));
    await screen.findByRole("heading", { name: "Checkout" });
    // idr_enabled -> qris wins the default-selection cascade.
    const qrisRadio = screen.getByRole("radio", { name: /QRIS/ }) as HTMLInputElement;
    expect(qrisRadio.checked).toBe(true);
    expect(screen.getAllByText("QRIS admin fee").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Rp1,206").length).toBeGreaterThan(0);
    // Order total row now shows the fee-inclusive grand total, not the bare total.
    expect(screen.getAllByText("Rp159,206").length).toBeGreaterThan(0);

    // Switching to another method drops the fee line and reverts the total.
    fireEvent.click(screen.getByRole("radio", { name: /BINANCE/ }));
    expect(screen.queryByText("QRIS admin fee")).not.toBeInTheDocument();
    expect(screen.getAllByText("Rp158,000").length).toBeGreaterThan(0);
  });

  // Touch ergonomics: the whole method row is the tap target, not just the
  // radio dot, and the selected row is styled as a whole so a thumb covering
  // the dot doesn't hide which rail is armed.
  it("selects a payment method by tapping anywhere on its row", async () => {
    renderCheckout(() => ({ ...checkoutData, wallet_idr: "200000" }));
    await screen.findByRole("heading", { name: "Checkout" });
    const walletRadio = screen.getByRole("radio", { name: /Wallet Credit \(IDR\)/ }) as HTMLInputElement;
    const row = walletRadio.closest("label")!;
    expect(row.className).toContain("has-[:checked]:border-pine");

    fireEvent.click(screen.getByText("Wallet Credit (IDR)"));
    expect(walletRadio.checked).toBe(true);
  });

  it("voucher Apply posts a preview and updates only the totals area", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    const input = screen.getByPlaceholderText("Code");
    fireEvent.change(input, { target: { value: "save10" } });

    const previewResponse: CheckoutData = {
      ...checkoutData,
      voucher_discount: "15800",
      total: "142200",
    };
    (apiPost as Mock).mockResolvedValue(previewResponse);

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout/voucher/preview", { voucher_code: "save10" }),
    );
    expect(await screen.findByText("Voucher")).toBeInTheDocument();
    expect(screen.getAllByText("Rp142,200").length).toBeGreaterThan(0);
    // The method radio area is untouched by the preview response.
    expect((screen.getByRole("radio", { name: /BINANCE/ }) as HTMLInputElement).checked).toBe(true);
    // The input's own live value is untouched by the response either.
    expect((input as HTMLInputElement).value).toBe("save10");
  });

  it("Enter in the voucher input triggers preview, not a form submit", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    const input = screen.getByPlaceholderText("Code");
    fireEvent.change(input, { target: { value: "ABC" } });
    (apiPost as Mock).mockResolvedValue(checkoutData);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout/voucher/preview", { voucher_code: "ABC" }),
    );
    // Never called the real order-placing endpoint.
    expect(apiPost).not.toHaveBeenCalledWith("/api/v1/checkout", expect.anything());
  });

  it("placing the order successfully navigates to pay_url", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    const response: PlaceOrderResponse = { order_code: "ORD123", pay_url: "/checkout/ORD123/pay" };
    (apiPost as Mock).mockResolvedValue(response);
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout", {
        method: "binance",
        voucher_code: "",
      }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
    );
    expect(await screen.findByText("pay-page-stub")).toBeInTheDocument();
  });

  it("renders the translated error on a 400 place-order response", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    (apiPost as Mock).mockRejectedValue(new Error("web.pay_method_unavailable"));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    expect(await screen.findByText("That payment method isn't available right now — pick another one.")).toBeInTheDocument();
  });

  // Whole-branch review F4a. The rail-minimum refusal names the figure it was
  // judged against — "below the minimum this payment method accepts ({min}
  // {currency})" — and the API layer now carries the server's `error_args` on the
  // thrown Error so those braces are filled. Before this, the buyer read the
  // braces themselves and was told nothing about how much more they needed.
  it("fills the placeholders of an error that carries args, and never shows raw braces", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    const err = new Error("error.amount_below_rail_minimum") as Error & {
      errorArgs?: Record<string, string>;
    };
    err.errorArgs = { min: "100000", currency: "IDR" };
    (apiPost as Mock).mockRejectedValue(err);
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    const rendered = await screen.findByText(/below the minimum this payment method accepts/);
    expect(rendered).toHaveTextContent("(100000 IDR)");
    expect(rendered.textContent).not.toMatch(/\{\w+\}/);
  });

  // The other half of the same change: a key with no args must render exactly as
  // it did before. Passing an empty arg set through the formatter is how a
  // template that legitimately contains braces-free copy would otherwise start
  // rendering differently.
  it("renders an args-free error exactly as before", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    (apiPost as Mock).mockRejectedValue(new Error("error.cart_empty"));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    expect(await screen.findByText("Your cart is empty.")).toBeInTheDocument();
  });

  // Guest checkout: an empty cart used to bounce to /cart, which for an
  // anonymous visitor is an equally empty screen one navigation away. The
  // page now states the situation where the buyer already is and names the
  // way out, and never renders a payment form for a cart with nothing in it.
  it("renders an empty state with a way out — not the payment form — when the cart is empty", async () => {
    renderCheckout(() => ({ ...checkoutData, items_empty: true }));
    expect(await screen.findByText("There's nothing to check out yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse products" })).toHaveAttribute("href", "/products");
    expect(screen.queryByRole("button", { name: /Place order/ })).not.toBeInTheDocument();
    expect(screen.queryByText("How would you like to pay?")).not.toBeInTheDocument();
  });

  // A 429 on the checkout GET (anonymous read throttle) used to leave the
  // page permanently blank — no spinner, no text, nothing to act on.
  it("renders an explained state with a way out when the checkout payload fails to load", async () => {
    renderCheckout(() => {
      const err = new Error("error.rate_limited") as Error & { status?: number };
      err.status = 429;
      throw err;
    });
    expect(await screen.findByText("We couldn't load your checkout")).toBeInTheDocument();
    expect(screen.getByText("Too many requests. Please wait a moment.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to cart" })).toHaveAttribute("href", "/cart");
  });

  // Task 10 (E4): the user was explicit that this state stays shelf-free —
  // their checkout just failed, it's an error, not a normal empty state.
  // Locked down so a later change can't quietly reintroduce it.
  it("never shows a product shelf when the checkout payload fails to load", async () => {
    renderCheckout(() => {
      const err = new Error("error.rate_limited") as Error & { status?: number };
      err.status = 429;
      throw err;
    });
    await screen.findByText("We couldn't load your checkout");
    expect(screen.queryByText("You might also like")).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/p/"]')).toBeNull();
  });

  // apiGet's fallback message for a body with no `error` key is a developer
  // string ("/api/v1/checkout responded 500"). It must never reach a shopper.
  it("apologises in plain language when the failure carries no i18n key", async () => {
    renderCheckout(() => {
      throw new Error("/api/v1/checkout responded 500");
    });
    expect(await screen.findByText("We couldn't load your checkout")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(screen.queryByText("/api/v1/checkout responded 500")).not.toBeInTheDocument();
  });

  // STO-005: the voucher error used to render in #checkout-summary, a full
  // column gutter away from the voucher input it's actually about.
  it("renders the voucher error next to the voucher input, not in the summary column", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    const input = screen.getByPlaceholderText("Code");
    fireEvent.change(input, { target: { value: "BADCODE" } });

    (apiPost as Mock).mockResolvedValue({ ...checkoutData, error_key: "error.voucher_not_found" });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Voucher code not found.");
    // Same card as the input (not #checkout-summary).
    expect(error.closest("#checkout-summary")).toBeNull();
    expect(input.closest(".card")).toBe(error.closest(".card"));
  });

  // Flash sales: the checkout totals are already priced with the discount, so
  // the summary only carries a modest marker (badge + one line of copy) — the
  // per-line strike-through and the countdown stay on cart/product. The flag
  // rides on the checkout payload's own items, priced against the same instant
  // as the totals it annotates.
  it("marks the summary when a checkout line is on a flash sale", async () => {
    const endsAt = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    renderCheckout(() => ({
      ...checkoutData,
      items: checkoutData.items.map((i) => ({
        ...i,
        flash: { discount_percent: "20", base_price: "79000", ends_at: endsAt },
      })),
    }));
    await screen.findByRole("heading", { name: "Checkout" });
    expect(await screen.findByText("Flash sale price applied")).toBeInTheDocument();
    expect(screen.getByText(/Flash sale −/)).toHaveTextContent("20%");
    // No countdown restated here.
    expect(screen.queryByText(/Ends in/)).not.toBeInTheDocument();
  });

  it("leaves the summary unmarked when no checkout line is on a flash sale", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    expect(screen.queryByText("Flash sale price applied")).not.toBeInTheDocument();
    expect(screen.queryByText(/Flash sale −/)).not.toBeInTheDocument();
  });

  // STO-012: the "No payment methods" empty state must actually link to
  // support, not just mention it as plain text.
  it("links 'contact support' to /account/support in the no-payment-methods empty state", async () => {
    renderCheckout(() => ({ ...checkoutData, binance_enabled: false }));
    await screen.findByRole("heading", { name: "Checkout" });
    expect(screen.getByText(/No payment methods are available/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "contact support" })).toHaveAttribute("href", "/account/support");
  });

  // Task 6: info-collection step for a manual_with_info cart (the
  // single-SKU-per-non-auto-cart guard means there's ever exactly one such
  // item). Renders one input group per additional_fields entry, repeated
  // `qty` times, gating "Place Order" until every unit validates.
  describe("manual_with_info info-collection step", () => {
    const fields: AdditionalField[] = [
      { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "e.g. ABC123" },
      { key: "email", label: { id: "Email", en: "Email" }, type: "email", required: true, options: [], placeholder: "" },
    ];
    const infoCheckoutData: CheckoutData = {
      ...checkoutData,
      items: [{ denomination_id: 5, delivery_type: "manual_with_info", additional_fields: fields, qty: 2 }],
    };

    it("renders nothing extra for an auto-only cart (no manual_with_info item)", async () => {
      renderCheckout(() => checkoutData);
      await screen.findByRole("heading", { name: "Checkout" });
      expect(screen.queryByText("Order details")).not.toBeInTheDocument();
    });

    it("renders one field group per unit (qty × fields.length inputs) with bilingual labels", async () => {
      renderCheckout(() => infoCheckoutData);
      await screen.findByText("Order details");
      expect(screen.getByText("Unit 1 of 2")).toBeInTheDocument();
      expect(screen.getByText("Unit 2 of 2")).toBeInTheDocument();
      expect(screen.getAllByLabelText("Game ID")).toHaveLength(2);
      expect(screen.getAllByLabelText("Email")).toHaveLength(2);
    });

    it("preserves every unit's answers while currency data is loading and after it resolves", async () => {
      const { queryClient } = renderCheckout(() => infoCheckoutData);
      await screen.findByText("Order details");
      for (const [unit, input] of screen.getAllByLabelText("Game ID").entries()) {
        fireEvent.change(input, { target: { value: `unit${unit + 1}game` } });
      }
      for (const [unit, input] of screen.getAllByLabelText("Email").entries()) {
        fireEvent.change(input, { target: { value: `unit${unit + 1}@mail.com` } });
      }
      let release!: (data: CheckoutData) => void;
      (apiGet as Mock).mockImplementation(() => new Promise<CheckoutData>((resolve) => { release = resolve; }));
      await act(async () => { queryClient.setQueryData(["context"], { ...context, currency: "USD" }); });
      await waitFor(() => expect(release).toBeDefined());
      expect(screen.getAllByLabelText("Game ID")[0]).toHaveValue("unit1game");
      expect(screen.getAllByLabelText("Game ID")[1]).toHaveValue("unit2game");
      await act(async () => { release({ ...infoCheckoutData, subtotal: "160000", total: "160000" }); });
      await waitFor(() => expect(queryClient.getQueryState(["checkout", "USD", "en", undefined])?.status).toBe("success"));
      expect(screen.getAllByLabelText("Game ID")[0]).toHaveValue("unit1game");
      expect(screen.getAllByLabelText("Game ID")[1]).toHaveValue("unit2game");
      (apiPost as Mock).mockResolvedValue({ order_code: "ORD456", pay_url: "/checkout/ORD456/pay" });
      fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
      await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout", expect.objectContaining({
        customer_data: [{ game_id: "unit1game", email: "unit1@mail.com" }, { game_id: "unit2game", email: "unit2@mail.com" }],
      }), expect.anything()));
    });

    it("disables Place Order until every unit's required fields are filled and valid", async () => {
      renderCheckout(() => infoCheckoutData);
      await screen.findByText("Order details");
      const placeOrderBtn = screen.getByRole("button", { name: /Place order/ });
      expect(placeOrderBtn).toBeDisabled();

      const gameIdInputs = screen.getAllByLabelText("Game ID");
      const emailInputs = screen.getAllByLabelText("Email");
      fireEvent.change(gameIdInputs[0]!, { target: { value: "unit1game" } });
      fireEvent.change(emailInputs[0]!, { target: { value: "not-an-email" } });
      fireEvent.change(gameIdInputs[1]!, { target: { value: "unit2game" } });
      fireEvent.change(emailInputs[1]!, { target: { value: "unit2@mail.com" } });
      // unit1's email is still invalid -> still disabled.
      expect(placeOrderBtn).toBeDisabled();
      expect(screen.queryByText("Please enter a valid email address.")).not.toBeInTheDocument();
      fireEvent.blur(emailInputs[0]!);
      expect(screen.getByText("Please enter a valid email address.")).toBeInTheDocument();

      fireEvent.change(emailInputs[0]!, { target: { value: "unit1@mail.com" } });
      expect(placeOrderBtn).not.toBeDisabled();
    });

    it("submits the collected answers as customer_data on Place Order", async () => {
      renderCheckout(() => infoCheckoutData);
      await screen.findByText("Order details");
      const gameIdInputs = screen.getAllByLabelText("Game ID");
      const emailInputs = screen.getAllByLabelText("Email");
      fireEvent.change(gameIdInputs[0]!, { target: { value: "unit1game" } });
      fireEvent.change(emailInputs[0]!, { target: { value: "unit1@mail.com" } });
      fireEvent.change(gameIdInputs[1]!, { target: { value: "unit2game" } });
      fireEvent.change(emailInputs[1]!, { target: { value: "unit2@mail.com" } });

      const response: PlaceOrderResponse = { order_code: "ORD456", pay_url: "/checkout/ORD456/pay" };
      (apiPost as Mock).mockResolvedValue(response);
      fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout", {
          method: "binance",
          voucher_code: "",
          customer_data: [
            { game_id: "unit1game", email: "unit1@mail.com" },
            { game_id: "unit2game", email: "unit2@mail.com" },
          ],
        }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
      );
    });

    // STO-010: buying qty>1 of the same manual_with_info product for oneself
    // shouldn't require retyping identical answers into every unit.
    it("'Copy to all units' fills every other unit with Unit 1's answers", async () => {
      renderCheckout(() => infoCheckoutData);
      await screen.findByText("Order details");
      const gameIdInputs = screen.getAllByLabelText("Game ID");
      const emailInputs = screen.getAllByLabelText("Email");
      fireEvent.change(gameIdInputs[0]!, { target: { value: "unit1game" } });
      fireEvent.change(emailInputs[0]!, { target: { value: "unit1@mail.com" } });
      expect((gameIdInputs[1] as HTMLInputElement).value).toBe("");

      fireEvent.click(screen.getByRole("button", { name: "Copy to all units" }));

      expect((gameIdInputs[1] as HTMLInputElement).value).toBe("unit1game");
      expect((emailInputs[1] as HTMLInputElement).value).toBe("unit1@mail.com");
      const placeOrderBtn = screen.getByRole("button", { name: /Place order/ });
      expect(placeOrderBtn).not.toBeDisabled();
    });

    it("renders a select field populated from field.options", async () => {
      const selectFields: AdditionalField[] = [
        { key: "region", label: { id: "Wilayah", en: "Region" }, type: "select", required: true, options: ["NA", "EU"], placeholder: "" },
      ];
      renderCheckout(() => ({
        ...checkoutData,
        items: [{ denomination_id: 5, delivery_type: "manual_with_info", additional_fields: selectFields, qty: 1 }],
      }));
      await screen.findByText("Order details");
      const select = screen.getByLabelText("Region") as HTMLSelectElement;
      expect(select.tagName).toBe("SELECT");
      fireEvent.change(select, { target: { value: "EU" } });
      expect(select.value).toBe("EU");
    });
  });

  // Mobile: the summary card stacks below the payment methods, so the total
  // was off-screen exactly while the buyer chose a rail. A fixed bottom bar
  // carries the live total plus the page's only submit control. jsdom has no
  // matchMedia, and useMediaQuery is mobile-first without it, so every test
  // above already exercises the mobile arm — these pin the behaviour down.
  describe("sticky mobile total bar", () => {
    /** Desktop arm: a matchMedia stand-in that matches the md breakpoint. */
    function stubDesktop(): void {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("shows the live total in the bar and keeps exactly one Place order button on mobile", async () => {
      renderCheckout(() => checkoutData);
      await screen.findByRole("heading", { name: "Checkout" });
      const bar = document.querySelector(".fixed.bottom-0")!;
      expect(bar).toBeInTheDocument();
      expect(bar).toHaveTextContent("Total");
      expect(bar).toHaveTextContent("Rp158,000");
      // One submit control at a time — the in-card button is desktop-only.
      expect(screen.getAllByRole("button", { name: /Place order/ })).toHaveLength(1);
      expect(bar.contains(screen.getByRole("button", { name: /Place order/ }))).toBe(true);
    });

    it("re-prices the bar from the voucher preview response", async () => {
      renderCheckout(() => checkoutData);
      await screen.findByRole("heading", { name: "Checkout" });
      fireEvent.change(screen.getByPlaceholderText("Code"), { target: { value: "save10" } });
      (apiPost as Mock).mockResolvedValue({ ...checkoutData, voucher_discount: "15800", total: "142200" });
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(document.querySelector(".fixed.bottom-0")).toHaveTextContent("Rp142,200"));
    });

    it("submits through the same handler and gating as the summary button", async () => {
      renderCheckout(() => ({
        ...checkoutData,
        items: [
          {
            denomination_id: 5,
            delivery_type: "manual_with_info",
            additional_fields: [
              { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
            ],
            qty: 1,
          },
        ],
      }));
      await screen.findByText("Order details");
      const barButton = screen.getByRole("button", { name: /Place order/ });
      expect(barButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Game ID"), { target: { value: "abc" } });
      expect(barButton).not.toBeDisabled();

      const response: PlaceOrderResponse = { order_code: "ORD321", pay_url: "/checkout/ORD321/pay" };
      (apiPost as Mock).mockResolvedValue(response);
      fireEvent.click(barButton);
      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout", {
          method: "binance",
          voucher_code: "",
          customer_data: [{ game_id: "abc" }],
        }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
      );
    });

    // Final-review fix: a USD-display viewer on an IDR-settlement rail
    // (QRIS/PayDisini) must see the Rp payable next to the $ figure, like the
    // bot's payAlongsidePriceLine. fx 16000: qris_grand_total 159206 → $9.96,
    // total 158000 → $9.88.
    describe("Price · Pay line for a USD viewer", () => {
      const usdContext: ShopContext = { ...context, currency: "USD" };
      const bar = () => document.querySelector(".fixed.bottom-0")!;

      it("QRIS: shows the $ total and the Rp payable the rail will charge", async () => {
        renderCheckout(() => ({ ...checkoutData, idr_enabled: true }), usdContext);
        await screen.findByRole("heading", { name: "Checkout" });
        await waitFor(() => expect(bar()).toHaveTextContent("Price $9.88 · Pay Rp159,206"));
        expect(bar()).toHaveTextContent("$9.96");
      });

      it("PayDisini: the Rp payable is the fee-free total", async () => {
        renderCheckout(() => ({ ...checkoutData, paydisini_enabled: true }), usdContext);
        await screen.findByRole("heading", { name: "Checkout" });
        await waitFor(() => expect(bar()).toHaveTextContent("Price $9.88 · Pay Rp158,000"));
      });

      it("USDT rail (binance default): no dual line", async () => {
        renderCheckout(() => checkoutData, usdContext);
        await screen.findByRole("heading", { name: "Checkout" });
        await waitFor(() => expect(bar()).toHaveTextContent("$9.88"));
        expect(bar()).not.toHaveTextContent("Pay Rp");
      });

      it("QRIS for an IDR / no-preference viewer: unchanged, Rp only", async () => {
        renderCheckout(() => ({ ...checkoutData, idr_enabled: true }), { ...context, currency: "IDR" });
        await screen.findByRole("heading", { name: "Checkout" });
        await waitFor(() => expect(bar()).toHaveTextContent("Rp159,206"));
        expect(bar()).not.toHaveTextContent("Pay Rp");
        expect(bar()).not.toHaveTextContent("$");
      });

      it("QRIS for a null-preference viewer: unchanged, no dual line", async () => {
        renderCheckout(() => ({ ...checkoutData, idr_enabled: true }));
        await screen.findByRole("heading", { name: "Checkout" });
        await waitFor(() => expect(bar()).toHaveTextContent("Rp159,206"));
        expect(bar()).not.toHaveTextContent("Pay Rp");
      });
    });

    it("is absent on desktop, where the summary card keeps the submit button", async () => {
      stubDesktop();
      renderCheckout(() => checkoutData);
      await screen.findByRole("heading", { name: "Checkout" });
      await waitFor(() => expect(document.querySelector(".fixed.bottom-0")).toBeNull());
      const placeOrder = screen.getByRole("button", { name: /Place order/ });
      expect(placeOrder.closest("#checkout-summary")).not.toBeNull();
    });
  });

  // Guest checkout (Task 6): an anonymous visitor completes the purchase from
  // this page without ever being sent to /login. The server decides — the page
  // reads `is_guest` and the two wallet_*_enabled flags off the payload rather
  // than inferring anything from the absence of a customer.
  describe("guest mode", () => {
    // The rendered `web.guest_email_invalid` string, named once so a copy
    // rewrite touches one line here instead of five. The wording itself is
    // guarded in packages/core/src/locales.test.ts: checkout-time copy is
    // written before anyone knows whether the order-code email will go out
    // (SMTP is optional per deployment), so it must never promise an inbox.
    const GUEST_EMAIL_INVALID = "Enter a valid email address — it's how the shop reaches you about this order.";

    const guestData: CheckoutData = {
      ...checkoutData,
      is_guest: true,
      // Server sends "0"/false for a guest; the balances are set non-zero here
      // on purpose, to prove the radios are gated on the *_enabled flags and
      // not on whether the numbers happen to cover the total.
      wallet_idr: "200000",
      wallet_usdt: "10",
      wallet_idr_enabled: false,
      wallet_usdt_enabled: false,
    };

    it("asks for an email, explains why, and offers sign-in as an option rather than a gate", async () => {
      renderCheckout(() => guestData);
      await screen.findByRole("heading", { name: "Checkout" });
      expect(screen.getByLabelText("Email address")).toBeInTheDocument();
      expect(screen.getByText(/save the order code shown there/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Already have an account? Sign in" })).toHaveAttribute(
        "href",
        "/login?next=/checkout",
      );
    });

    it("hides both wallet-credit methods for a guest even when the balances would cover the total", async () => {
      renderCheckout(() => guestData);
      await screen.findByRole("heading", { name: "Checkout" });
      expect(screen.queryByText("Wallet Credit (IDR)")).not.toBeInTheDocument();
      expect(screen.queryByText("Wallet Credit (USDT)")).not.toBeInTheDocument();
    });

    it("shows no email field for a signed-in buyer (regression: their page is unchanged)", async () => {
      renderCheckout(() => checkoutData);
      await screen.findByRole("heading", { name: "Checkout" });
      expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Already have an account/ })).not.toBeInTheDocument();
    });

    it("sends guest_email with the order and leaves the page for pay_url on success", async () => {
      const assign = vi.fn();
      const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
      Object.defineProperty(window, "location", { configurable: true, writable: true, value: { assign } });
      try {
        renderCheckout(() => guestData);
        await screen.findByRole("heading", { name: "Checkout" });
        fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "guest@example.com" } });

        (apiPost as Mock).mockResolvedValue({
          order_code: "ORD900",
          pay_url: "/checkout/ORD900/pay",
          csrf_token: "guest-token",
        });
        fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

        await waitFor(() =>
          expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout", {
            method: "binance",
            voucher_code: "",
            guest_email: "guest@example.com",
          }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
        );
        // Full page load, not navigate(): the shell has to re-render so the
        // whole app (account menu, CSRF meta) sees the new guest session.
        await waitFor(() => expect(assign).toHaveBeenCalledWith("/checkout/ORD900/pay"));
      } finally {
        if (originalLocation) Object.defineProperty(window, "location", originalLocation);
      }
    });

    it("still full-reloads on a RETRY, where the response carries no csrf_token", async () => {
      // The retry after a failed guest checkout takes the server's signed-in
      // branch (the first attempt already minted the session), so no
      // `csrf_token` comes back. Keying the reload on that field alone left
      // the shopper on a client-side navigation with the shell still rendered
      // from the anonymous page load — header saying "Sign in" while a live
      // session sat in the cookie jar. `page.is_guest` is the durable signal.
      const assign = vi.fn();
      const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
      Object.defineProperty(window, "location", { configurable: true, writable: true, value: { assign } });
      try {
        renderCheckout(() => guestData);
        await screen.findByRole("heading", { name: "Checkout" });
        fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "guest@example.com" } });

        (apiPost as Mock).mockResolvedValue({ order_code: "ORD901", pay_url: "/checkout/ORD901/pay" });
        fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

        await waitFor(() => expect(assign).toHaveBeenCalledWith("/checkout/ORD901/pay"));
        // Not a client-side route change: the stub for that path must not render.
        expect(screen.queryByText("pay-page-stub")).not.toBeInTheDocument();
      } finally {
        if (originalLocation) Object.defineProperty(window, "location", originalLocation);
      }
    });

    it("refreshes the shop context after a FAILED guest attempt, so the header and cart badge catch up", async () => {
      // Guest checkout mints the session before it tries to place the order,
      // and establishing it migrates the cookie cart into CartItem rows and
      // clears the cookie. When the order then fails, the cached
      // /pages/context still describes an anonymous visitor with a
      // cookie-counted cart — header on "Sign in", badge on 0 — even though
      // the buyer now holds a live session and a full server-side cart.
      // Invalidating the query re-reads both from the server.
      renderCheckout(() => guestData);
      await screen.findByRole("heading", { name: "Checkout" });
      const contextCallsBefore = (apiGet as Mock).mock.calls.filter((c) => c[0] === "/api/v1/pages/context").length;

      fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "guest@example.com" } });
      (apiPost as Mock).mockRejectedValue(new Error("/api/v1/checkout responded 500"));
      fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

      await waitFor(() => {
        const after = (apiGet as Mock).mock.calls.filter((c) => c[0] === "/api/v1/pages/context").length;
        expect(after).toBeGreaterThan(contextCallsBefore);
      });
    });

    it("does not refresh the shop context when a SIGNED-IN buyer's order fails", async () => {
      // No session was minted and no cart moved, so there is nothing stale to
      // re-read — a refetch here would just be an extra request per failure.
      renderCheckout(() => checkoutData);
      await screen.findByRole("heading", { name: "Checkout" });
      const contextCallsBefore = (apiGet as Mock).mock.calls.filter((c) => c[0] === "/api/v1/pages/context").length;

      (apiPost as Mock).mockRejectedValue(new Error("/api/v1/checkout responded 500"));
      fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

      await screen.findByText("Something went wrong. Please try again.");
      const after = (apiGet as Mock).mock.calls.filter((c) => c[0] === "/api/v1/pages/context").length;
      expect(after).toBe(contextCallsBefore);
    });

    it("keeps the buyer on the page with a readable message when the server rejects the email", async () => {
      renderCheckout(() => guestData);
      await screen.findByRole("heading", { name: "Checkout" });
      fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "typo@example.com" } });
      (apiPost as Mock).mockRejectedValue(new Error("web.guest_email_invalid"));
      fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

      // Once, against the field that has to change — not also in a page-level
      // banner a column away from the input (STO-005's rule for the voucher
      // error applies here too).
      const message = await screen.findByText(GUEST_EMAIL_INVALID);
      expect(screen.getAllByText(GUEST_EMAIL_INVALID)).toHaveLength(1);
      // Still on checkout, with the field editable, so the retry the adopted
      // CSRF token makes possible is actually reachable.
      const email = screen.getByLabelText("Email address");
      expect(email).toBeInTheDocument();
      expect(email.getAttribute("aria-describedby")?.split(/\s+/)).toContain(message.id);
      expect(screen.getByRole("button", { name: /Place order/ })).not.toBeDisabled();
    });

    it("translates a 429 into plain language instead of showing the raw error key", async () => {
      renderCheckout(() => guestData);
      await screen.findByRole("heading", { name: "Checkout" });
      fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "guest@example.com" } });
      (apiPost as Mock).mockRejectedValue(new Error("error.rate_limited"));
      fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
      expect(await screen.findByText("Too many requests. Please wait a moment.")).toBeInTheDocument();
      expect(screen.queryByText("error.rate_limited")).not.toBeInTheDocument();
    });

    it("apologises in plain language when a rejected order carries no i18n key", async () => {
      renderCheckout(() => guestData);
      await screen.findByRole("heading", { name: "Checkout" });
      fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "guest@example.com" } });
      (apiPost as Mock).mockRejectedValue(new Error("/api/v1/checkout responded 500"));
      fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
      expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
      expect(screen.queryByText("/api/v1/checkout responded 500")).not.toBeInTheDocument();
    });

    it("holds Place order back until the email looks like an email (client-side courtesy only)", async () => {
      renderCheckout(() => guestData);
      await screen.findByRole("heading", { name: "Checkout" });
      const placeOrder = screen.getByRole("button", { name: /Place order/ });
      expect(placeOrder).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "not-an-email" } });
      expect(placeOrder).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "guest@example.com" } });
      expect(placeOrder).not.toBeDisabled();
    });

    // The dimmed Place order button is one of three blockers; the other two
    // (no payment method, an incomplete info step) explain themselves on the
    // page. This one used to say nothing at all — the native `required`
    // attribute is inert here, since the button is type="button" and the form
    // preventDefaults, so the browser never runs constraint validation.
    it("marks the email required up front, before anyone has touched it", async () => {
      renderCheckout(() => guestData);
      await screen.findByRole("heading", { name: "Checkout" });
      expect(screen.getByText("Required")).toBeInTheDocument();
      // But does not scold a shopper who has not typed anything yet.
      expect(
        screen.queryByText(GUEST_EMAIL_INVALID),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Email address")).not.toHaveAttribute("aria-invalid", "true");
    });

    it("explains the invalid email inline once the shopper has interacted, wired up for a screen reader", async () => {
      renderCheckout(() => guestData);
      await screen.findByRole("heading", { name: "Checkout" });
      const email = screen.getByLabelText("Email address");

      fireEvent.change(email, { target: { value: "not-an-email" } });
      fireEvent.blur(email);

      const message = await screen.findByText(GUEST_EMAIL_INVALID);
      expect(email).toHaveAttribute("aria-invalid", "true");
      // aria-invalid alone announces "invalid" with no reason attached — the
      // message has to be reachable from the field itself.
      expect(message.id).toBeTruthy();
      expect(email.getAttribute("aria-describedby")?.split(/\s+/)).toContain(message.id);

      // ...and clears the moment the address is fixed.
      fireEvent.change(email, { target: { value: "guest@example.com" } });
      await waitFor(() =>
        expect(
          screen.queryByText(GUEST_EMAIL_INVALID),
        ).not.toBeInTheDocument(),
      );
      expect(email).not.toHaveAttribute("aria-invalid", "true");
    });

    // The server mails a guest their order code and reports whether the mail
    // actually went out (`email_sent` — SMTP is optional per deployment). This
    // page can render nothing about it: the success path is a full page load,
    // so anything shown here is torn down before it can be read. It hands the
    // fact to the destination instead, and PayPage.test.tsx covers the
    // rendering. Only `true` may ever produce a promise of an email.
    describe("order-code email notice handoff", () => {
      interface FakeStorage {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
        removeItem(key: string): void;
      }
      function installStorage(): void {
        const entries = new Map<string, string>();
        const storage: FakeStorage = {
          getItem: (key) => (entries.has(key) ? entries.get(key)! : null),
          setItem: (key, value) => {
            entries.set(key, value);
          },
          removeItem: (key) => {
            entries.delete(key);
          },
        };
        Object.defineProperty(window, "sessionStorage", { value: storage, configurable: true });
      }

      /** Place a guest order whose 201 carries `email_sent`, and report what
       * the pay page would find waiting for it. */
      async function placeGuestOrder(emailSent: boolean | undefined): Promise<string | null> {
        installStorage();
        const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
        Object.defineProperty(window, "location", { configurable: true, writable: true, value: { assign: vi.fn() } });
        try {
          renderCheckout(() => guestData);
          await screen.findByRole("heading", { name: "Checkout" });
          fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "guest@example.com" } });
          (apiPost as Mock).mockResolvedValue({
            order_code: "ORD902",
            pay_url: "/checkout/ORD902/pay",
            csrf_token: "guest-token",
            ...(emailSent === undefined ? {} : { email_sent: emailSent }),
          });
          fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
          await waitFor(() => expect((window.location.assign as Mock).mock.calls.length).toBe(1));
          return readCodeEmailed("ORD902");
        } finally {
          if (originalLocation) Object.defineProperty(window, "location", originalLocation);
        }
      }

      it("hands the pay page the address when the server actually sent the mail", async () => {
        expect(await placeGuestOrder(true)).toBe("guest@example.com");
      });

      it("hands over nothing when the server did not send the mail", async () => {
        expect(await placeGuestOrder(false)).toBeNull();
      });

      it("hands over nothing when the response says nothing about mail at all", async () => {
        // A signed-in 201 carries no `email_sent` key; neither may an older
        // server. Absent is not "sent".
        expect(await placeGuestOrder(undefined)).toBeNull();
      });
    });

    it("never redirects an anonymous visitor to /login on a 401", async () => {
      const assign = vi.fn();
      const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
      Object.defineProperty(window, "location", { configurable: true, writable: true, value: { assign } });
      try {
        renderCheckout(() => {
          const err = new Error("unauthorized") as Error & { status?: number };
          err.status = 401;
          throw err;
        });
        expect(await screen.findByText("We couldn't load your checkout")).toBeInTheDocument();
        expect(assign).not.toHaveBeenCalled();
      } finally {
        if (originalLocation) Object.defineProperty(window, "location", originalLocation);
      }
    });
  });

  describe("wallet credit as a payment method", () => {
    it("is absent when wallet balances don't cover the total (default fixture)", async () => {
      renderCheckout(() => checkoutData);
      await screen.findByRole("heading", { name: "Checkout" });
      expect(screen.queryByText("Wallet Credit (IDR)")).not.toBeInTheDocument();
      expect(screen.queryByText("Wallet Credit (USDT)")).not.toBeInTheDocument();
    });

    it("shows a Wallet Credit (IDR) radio when wallet_idr covers the total, and posts wallet_idr on Place order", async () => {
      renderCheckout(() => ({ ...checkoutData, wallet_idr: "200000" }));
      await screen.findByRole("heading", { name: "Checkout" });
      // Binance (the gateway) is still the default selection — the buyer must
      // opt into spending their credit explicitly.
      expect((screen.getByRole("radio", { name: /BINANCE/ }) as HTMLInputElement).checked).toBe(true);

      fireEvent.click(screen.getByRole("radio", { name: /Wallet Credit \(IDR\)/ }));

      const response: PlaceOrderResponse = { order_code: "ORD789", pay_url: "/account/orders/ORD789" };
      (apiPost as Mock).mockResolvedValue(response);
      fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout", {
          method: "wallet_idr",
          voucher_code: "",
        }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
      );
      expect(await screen.findByText("order-detail-stub")).toBeInTheDocument();
    });

    it("shows a Wallet Credit (USDT) radio when wallet_usdt covers total_usdt, and posts wallet_usdt on Place order", async () => {
      renderCheckout(() => ({ ...checkoutData, wallet_usdt: "10" })); // total_usdt fixture is 9.88
      await screen.findByRole("heading", { name: "Checkout" });
      fireEvent.click(screen.getByRole("radio", { name: /Wallet Credit \(USDT\)/ }));

      const response: PlaceOrderResponse = { order_code: "ORD790", pay_url: "/account/orders/ORD790" };
      (apiPost as Mock).mockResolvedValue(response);
      fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout", {
          method: "wallet_usdt",
          voucher_code: "",
        }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
      );
      expect(await screen.findByText("order-detail-stub")).toBeInTheDocument();
    });

    it("defaults to Wallet Credit and clears the empty-state message when no gateway is enabled but the balance covers the total", async () => {
      renderCheckout(() => ({
        ...checkoutData,
        binance_enabled: false, // fixture default has only binance enabled -> now nothing is
        wallet_idr: "200000",
      }));
      await screen.findByRole("heading", { name: "Checkout" });
      expect((screen.getByRole("radio", { name: /Wallet Credit \(IDR\)/ }) as HTMLInputElement).checked).toBe(true);
      expect(screen.queryByText(/No payment methods are available/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Place order/ })).not.toBeDisabled();
    });

    // Regression (code review finding I-1): the PaymentMethodSelector
    // extraction changed which payload gates wallet-credit availability —
    // it used to be passed the live, voucher-adjusted `totals`, and got
    // changed to the stale, pre-voucher `page` seeded once from the initial
    // GET. A buyer whose voucher brings the total within their wallet
    // balance never saw the row appear. Existing coverage above only tests
    // "wallet without a voucher" and "voucher without wallet" — never the
    // crossing case, which is exactly what silently broke.
    it("shows the wallet-credit row once a voucher brings the (live) total within the wallet balance — was gated on the stale pre-voucher total", async () => {
      // wallet_idr (150000) doesn't cover the fixture's 158000 total yet.
      renderCheckout(() => ({ ...checkoutData, wallet_idr: "150000" }));
      await screen.findByRole("heading", { name: "Checkout" });
      expect(screen.queryByText("Wallet Credit (IDR)")).not.toBeInTheDocument();

      const input = screen.getByPlaceholderText("Code");
      fireEvent.change(input, { target: { value: "save10" } });
      (apiPost as Mock).mockResolvedValue({
        ...checkoutData,
        wallet_idr: "150000",
        voucher_discount: "18000",
        total: "140000", // now within the 150000 wallet balance
      });
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));

      const walletRadio = (await screen.findByRole("radio", {
        name: /Wallet Credit \(IDR\)/,
      })) as HTMLInputElement;
      fireEvent.click(walletRadio);
      expect(walletRadio.checked).toBe(true);
    });

    it("Place order stays disabled until every unit's manual_with_info fields validate, even with wallet credit selected", async () => {
      const fields: AdditionalField[] = [
        { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      ];
      renderCheckout(() => ({
        ...checkoutData,
        wallet_idr: "200000",
        items: [{ denomination_id: 5, delivery_type: "manual_with_info", additional_fields: fields, qty: 1 }],
      }));
      await screen.findByText("Order details");
      fireEvent.click(screen.getByRole("radio", { name: /Wallet Credit \(IDR\)/ }));
      const placeOrderBtn = screen.getByRole("button", { name: /Place order/ });
      expect(placeOrderBtn).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Game ID"), { target: { value: "abc" } });
      expect(placeOrderBtn).not.toBeDisabled();
    });
  });
});

// Idempotency-Key (doc section 22.1). POST /api/v1/checkout is the one call on
// this page that creates an order, and routes/api.ts replays the first
// attempt's stored response when a retry arrives with the same key and the
// same request. What matters here is the key's LIFECYCLE, so these assert the
// header value itself across two clicks, not merely that apiPost was called.
describe("CheckoutPage — Idempotency-Key", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  /** The keys the place-order call carried, in click order. */
  function placeOrderKeys(): string[] {
    return (apiPost as Mock).mock.calls
      .filter((c) => c[0] === "/api/v1/checkout")
      .map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
  }

  it("retrying an attempt that never came back sends the byte-identical key", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    // A transport failure: `onResponse` never fires, so the outcome is
    // unknown — the order may well exist and only the response was lost.
    (apiPost as Mock).mockRejectedValue(new TypeError("Failed to fetch"));

    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await waitFor(() => expect(placeOrderKeys()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await waitFor(() => expect(placeOrderKeys()).toHaveLength(2));

    const [first, second] = placeOrderKeys();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
  });

  it("starts a new operation with a new key when the buyer changes the payment method after a failure", async () => {
    renderCheckout(() => ({ ...checkoutData, idr_enabled: true }));
    await screen.findByRole("heading", { name: "Checkout" });
    (apiPost as Mock).mockRejectedValue(new TypeError("Failed to fetch"));

    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await waitFor(() => expect(placeOrderKeys()).toHaveLength(1));

    // A different `method` is a different request — and `method` is in the
    // server's own request hash, so reusing the key here would earn a 409
    // `error.idempotency_key_reused` rather than any protection.
    fireEvent.click(screen.getByRole("radio", { name: /BINANCE/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await waitFor(() => expect(placeOrderKeys()).toHaveLength(2));

    const [first, second] = placeOrderKeys();
    expect(second).not.toBe(first);
  });

  it("mints a fresh key for the next attempt once the server has answered", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    // The server answered (4xx) — the outcome is known and the route has
    // already stored it against the key, so reusing the key could only hand
    // the buyer the identical error again. The next click is a new operation.
    (apiPost as Mock).mockImplementation(
      async (_path: string, _body: unknown, options?: { onResponse?: (status: number) => void }) => {
        options?.onResponse?.(400);
        throw new Error("web.out_of_stock");
      },
    );

    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await waitFor(() => expect(placeOrderKeys()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await waitFor(() => expect(placeOrderKeys()).toHaveLength(2));

    const [first, second] = placeOrderKeys();
    expect(second).not.toBe(first);
  });

  it("leaves the voucher preview — which creates nothing — without a key", async () => {
    renderCheckout(() => checkoutData);
    await screen.findByRole("heading", { name: "Checkout" });
    (apiPost as Mock).mockResolvedValue(checkoutData);

    fireEvent.change(screen.getByPlaceholderText("Code"), { target: { value: "SAVE10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/checkout/voucher/preview", { voucher_code: "SAVE10" }),
    );
  });
});
