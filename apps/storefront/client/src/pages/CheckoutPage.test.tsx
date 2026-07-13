import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
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
        use_wallet_idr: false,
        use_wallet_usdt: false,
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

  it("navigates to /cart when the cart is empty", async () => {
    renderCheckout(() => ({ ...checkoutData, items_empty: true }));
    expect(await screen.findByText("cart-page-stub")).toBeInTheDocument();
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
          use_wallet_idr: false,
          use_wallet_usdt: false,
          customer_data: [
            { game_id: "unit1game", email: "unit1@mail.com" },
            { game_id: "unit2game", email: "unit2@mail.com" },
          ],
        }),
      );
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
});
