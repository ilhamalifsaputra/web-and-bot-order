import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OrderSummaryCard from "./OrderSummaryCard";
import { apiGet } from "../../api/client";
import type { CheckoutData, ShopContext } from "../../api/types";

// OrderSummaryCard reads the display-currency preference off the shared
// ["context"] query, like Price.tsx — seed that cache directly so the first
// render already carries the currency under test (see Price.test.tsx).
vi.mock("../../api/client", () => ({
  apiGet: vi.fn(),
}));

const baseContext: ShopContext = {
  lang: "en",
  fx: "16000",
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 1,
  customer: null,
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  wa_number: null,
  tzname: "Asia/Jakarta",
  currency: null,
};

const totals: CheckoutData = {
  items_empty: false,
  items: [{ denomination_id: 1, delivery_type: "auto", additional_fields: [], qty: 1 }],
  subtotal: "158000",
  bulk_discount: "0",
  voucher_discount: "0",
  total: "158000",
  qris_admin_fee: "1206",
  qris_grand_total: "159206",
  total_usdt: "9.88",
  voucher_code: "",
  error_key: null,
  binance_enabled: true,
  bybit_enabled: false,
  bybit_bsc_enabled: false,
  idr_enabled: true,
  paydisini_enabled: true,
  nowpayments_enabled: false,
  wallet_idr: "0",
  wallet_usdt: "0",
  wallet_idr_enabled: false,
  wallet_usdt_enabled: false,
  is_guest: false,
  below_all_minimums: false,
};

function renderCard(currency: ShopContext["currency"], method: string, fx: string | null = "16000") {
  const ctx: ShopContext = { ...baseContext, currency, fx };
  (apiGet as Mock).mockResolvedValue(ctx);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["context"], ctx);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OrderSummaryCard
          totals={totals}
          method={method}
          fx={fx}
          voucherInput=""
          onVoucherInputChange={() => {}}
          onVoucherApply={() => {}}
          onVoucherKeyDown={() => {}}
          voucherPending={false}
          showDesktopSubmit={false}
          submitLabel="Place order"
          submitDisabled={false}
          submitBlocked={false}
          onSubmit={() => {}}
          submitPending={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return document.querySelector("#checkout-summary")!;
}

describe("OrderSummaryCard — Price · Pay on IDR rails for a USD viewer", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  // fx 16000: fee 1206 → $0.08, grand total 159206 → $9.96 (ceil, formatPriceFor).
  it("QRIS + USD: shows the $ fee and total AND the native Rp figures the rail will charge", () => {
    const summary = renderCard("USD", "qris");
    expect(summary).toHaveTextContent("$0.08");
    expect(summary).toHaveTextContent("Rp1.206");
    expect(summary).toHaveTextContent("$9.96");
    expect(summary).toHaveTextContent("Price $9.88 · Pay Rp159.206");
  });

  it("QRIS + USD in Indonesian uses the shared checkout.price_and_pay wording", () => {
    document.documentElement.lang = "id";
    const summary = renderCard("USD", "qris");
    expect(summary).toHaveTextContent("Harga $9.88 · Bayar Rp159.206");
  });

  it("PayDisini + USD: shows the Rp payable (no QRIS fee) alongside the $ total", () => {
    const summary = renderCard("USD", "paydisini");
    expect(summary).toHaveTextContent("Price $9.88 · Pay Rp158.000");
  });

  it("QRIS + IDR: unchanged — Rp only, no Price · Pay line", () => {
    const summary = renderCard("IDR", "qris");
    expect(summary).toHaveTextContent("Rp1.206");
    expect(summary).toHaveTextContent("Rp159.206");
    expect(summary).not.toHaveTextContent("Pay Rp");
    expect(summary).not.toHaveTextContent("$0.08");
  });

  it("QRIS + no preference (null): unchanged — no Price · Pay line", () => {
    const summary = renderCard(null, "qris");
    expect(summary).toHaveTextContent("Rp159.206");
    expect(summary).not.toHaveTextContent("Pay Rp");
  });

  it("QRIS + USD but no usable rate: formatPriceFor already falls back to Rp, so no dual line", () => {
    const summary = renderCard("USD", "qris", null);
    expect(summary).toHaveTextContent("Rp159.206");
    expect(summary).not.toHaveTextContent("Pay Rp");
  });

  it("USDT rail (binance) + USD: no dual line, no Rp payable", () => {
    const summary = renderCard("USD", "binance");
    expect(summary).toHaveTextContent("$9.88");
    expect(summary).not.toHaveTextContent("Pay Rp");
    expect(summary).not.toHaveTextContent("Rp158.000");
  });
});
