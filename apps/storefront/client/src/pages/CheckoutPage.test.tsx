import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CheckoutPage from "./CheckoutPage";
import { apiGet, apiPost } from "../api/client";
import type { CheckoutData, PlaceOrderResponse, ShopContext } from "../api/types";

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
});
