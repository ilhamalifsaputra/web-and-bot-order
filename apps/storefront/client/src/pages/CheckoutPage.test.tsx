import "@testing-library/jest-dom";
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CheckoutPage from "./CheckoutPage";
import { apiGet, apiPost } from "../api/client";
import type { AdditionalField, CheckoutData, PlaceOrderResponse, ShopContext } from "../api/types";

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
  tzname: "Asia/Jakarta",
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
};

function renderCheckout(respond: (path: string) => unknown) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    return respond(path);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
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
    expect(screen.getAllByText("Rp158.000").length).toBeGreaterThan(0);
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
    expect(screen.getAllByText("Rp1.206").length).toBeGreaterThan(0);
    // Order total row now shows the fee-inclusive grand total, not the bare total.
    expect(screen.getAllByText("Rp159.206").length).toBeGreaterThan(0);

    // Switching to another method drops the fee line and reverts the total.
    fireEvent.click(screen.getByRole("radio", { name: /BINANCE/ }));
    expect(screen.queryByText("QRIS admin fee")).not.toBeInTheDocument();
    expect(screen.getAllByText("Rp158.000").length).toBeGreaterThan(0);
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
    expect(screen.getAllByText("Rp142.200").length).toBeGreaterThan(0);
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
      }),
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
        }),
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
      expect(bar).toHaveTextContent("Rp158.000");
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
      await waitFor(() => expect(document.querySelector(".fixed.bottom-0")).toHaveTextContent("Rp142.200"));
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
        }),
      );
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
      expect(screen.getByText(/look the order up later/)).toBeInTheDocument();
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
          }),
        );
        // Full page load, not navigate(): the shell has to re-render so the
        // whole app (account menu, CSRF meta) sees the new guest session.
        await waitFor(() => expect(assign).toHaveBeenCalledWith("/checkout/ORD900/pay"));
      } finally {
        if (originalLocation) Object.defineProperty(window, "location", originalLocation);
      }
    });

    it("keeps the buyer on the page with a readable message when the server rejects the email", async () => {
      renderCheckout(() => guestData);
      await screen.findByRole("heading", { name: "Checkout" });
      fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "typo@example.com" } });
      (apiPost as Mock).mockRejectedValue(new Error("web.guest_email_invalid"));
      fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

      expect(
        await screen.findByText("Enter a valid email address — we send your order details there."),
      ).toBeInTheDocument();
      // Still on checkout, with the field editable, so the retry the adopted
      // CSRF token makes possible is actually reachable.
      expect(screen.getByLabelText("Email address")).toBeInTheDocument();
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
        }),
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
        }),
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
