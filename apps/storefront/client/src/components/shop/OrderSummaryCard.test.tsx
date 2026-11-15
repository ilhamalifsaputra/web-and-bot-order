import "@testing-library/jest-dom/vitest";
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

  // fx 16000: total 158000 → $9.88. The QRIS admin fee is set by TokoPay when
  // the QR is created, so before that there is no fee figure to show.
  it("QRIS + USD: shows the plain $ total AND the Rp order total, with no fee figure", () => {
    const summary = renderCard("USD", "qris");
    expect(summary).toHaveTextContent("$9.88");
    expect(summary).toHaveTextContent("Price $9.88 · Pay Rp158,000");
    expect(summary).not.toHaveTextContent("Rp1,206");
    expect(summary).not.toHaveTextContent("$9.96");
  });

  it("QRIS + USD in Indonesian uses the shared checkout.price_and_pay wording", () => {
    document.documentElement.lang = "id";
    const summary = renderCard("USD", "qris");
    expect(summary).toHaveTextContent("Harga $9,88 · Bayar Rp158.000");
  });

  it("PayDisini + USD: shows the Rp payable (no QRIS fee) alongside the $ total", () => {
    const summary = renderCard("USD", "paydisini");
    expect(summary).toHaveTextContent("Price $9.88 · Pay Rp158,000");
  });

  it("QRIS + IDR: Rp only, no Price · Pay line", () => {
    const summary = renderCard("IDR", "qris");
    expect(summary).toHaveTextContent("Rp158,000");
    expect(summary).not.toHaveTextContent("Pay Rp");
    expect(summary).not.toHaveTextContent("$9.88");
  });

  it("QRIS + no preference (null): no Price · Pay line", () => {
    const summary = renderCard(null, "qris");
    expect(summary).toHaveTextContent("Rp158,000");
    expect(summary).not.toHaveTextContent("Pay Rp");
  });

  it("QRIS + USD but no usable rate: formatPriceFor already falls back to Rp, so no dual line", () => {
    const summary = renderCard("USD", "qris", null);
    expect(summary).toHaveTextContent("Rp158,000");
    expect(summary).not.toHaveTextContent("Pay Rp");
  });

  // Follow-up fix: wallet-IDR is not a gateway rail, but it is still an
  // IDR-settled debit, so a USD viewer gets the same Rp anchor (no fee).
  it("wallet_idr + USD: shows the Rp debit (no fee) alongside the $ total", () => {
    const summary = renderCard("USD", "wallet_idr");
    expect(summary).toHaveTextContent("Price $9.88 · Pay Rp158,000");
  });

  it.each([["IDR"], [null]] as const)("wallet_idr + %s: unchanged — no Price · Pay line", (currency) => {
    const summary = renderCard(currency, "wallet_idr");
    expect(summary).toHaveTextContent("Rp158,000");
    expect(summary).not.toHaveTextContent("Pay Rp");
  });

  it("wallet_usdt + USD: no dual line, no Rp payable", () => {
    const summary = renderCard("USD", "wallet_usdt");
    expect(summary).not.toHaveTextContent("Pay Rp");
  });

  it("USDT rail (binance) + USD: no dual line, no Rp payable", () => {
    const summary = renderCard("USD", "binance");
    expect(summary).toHaveTextContent("$9.88");
    expect(summary).not.toHaveTextContent("Pay Rp");
    expect(summary).not.toHaveTextContent("Rp158,000");
  });
});

// H-31 (storefront visual hierarchy, batch 5): the total is the page's key
// figure — larger than its "Total" label and styled like the other big totals
// (`font-display font-semibold text-pine text-2xl`).
describe("OrderSummaryCard — total emphasis", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders the total figure at text-2xl in the display font, not text-lg", () => {
    const summary = renderCard("IDR", "qris");
    const label = Array.from(summary.querySelectorAll("span")).find((s) => s.textContent === "Total")!;
    const row = label.parentElement!;
    const figure = row.querySelector(".text-2xl")!;
    expect(figure).toHaveTextContent("Rp158,000");
    expect(figure.closest(".font-display")).not.toBeNull();
    expect(row.querySelector(".text-lg")).toBeNull();
  });
});

// No QRIS admin fee figure exists before the QR: TokoPay sets it when the
// transaction is created, and the pay page then shows TokoPay's own figure.
describe("OrderSummaryCard — QRIS admin fee before the QR", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  function feeRow(summary: Element): HTMLElement | null {
    const label = Array.from(summary.querySelectorAll("span")).find((s) => s.textContent === "QRIS admin fee");
    return label ? label.parentElement : null;
  }

  it.each([["IDR"], ["USD"], [null]] as const)("QRIS + %s: the fee row says it is added on the payment page and shows no figure", (currency) => {
    const summary = renderCard(currency, "qris");
    const row = feeRow(summary);
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("Added on the payment page");
    expect(row!.textContent).not.toMatch(/Rp|\$|\d/);
  });

  it("QRIS in Indonesian: the fee row uses the Indonesian note", () => {
    document.documentElement.lang = "id";
    const summary = renderCard("IDR", "qris");
    const label = Array.from(summary.querySelectorAll("span")).find((s) => s.textContent === "Biaya admin QRIS")!;
    expect(label.parentElement).toHaveTextContent("Ditambahkan di halaman pembayaran");
  });

  it("QRIS: the order total is the plain checkout total", () => {
    const summary = renderCard("IDR", "qris");
    const label = Array.from(summary.querySelectorAll("span")).find((s) => s.textContent === "Total")!;
    expect(label.parentElement!.querySelector(".text-2xl")).toHaveTextContent("Rp158,000");
  });

  it.each([["paydisini"], ["wallet_idr"], ["binance"]])("%s: no QRIS admin fee row at all", (method) => {
    const summary = renderCard("IDR", method);
    expect(feeRow(summary)).toBeNull();
    expect(summary).not.toHaveTextContent("Added on the payment page");
  });
});

describe("OrderSummaryCard — volume tiers and the changed-price notice", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  function renderWith(data: CheckoutData, quoteChanged = false) {
    const ctx: ShopContext = { ...baseContext, currency: "IDR" };
    (apiGet as Mock).mockResolvedValue(ctx);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["context"], ctx);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <OrderSummaryCard
            totals={data}
            method="binance"
            fx="16000"
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
            quoteChanged={quoteChanged}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return document.querySelector("#checkout-summary")!;
  }

  const tiered: CheckoutData = {
    ...totals,
    items: [{
      denomination_id: 1, delivery_type: "auto", additional_fields: [], qty: 6,
      pricing: {
        quantity: 6, base_unit_price: "10000", final_unit_price: "6000", original_subtotal: "60000",
        final_subtotal: "36000", savings: "24000",
        applied_tier: { min_quantity: 5, discount_type: "FIXED_UNIT_PRICE", discount_value: "6000" },
      },
    }],
    subtotal: "60000",
    bulk_discount: "24000",
    total: "36000",
  };

  it("lists the tier-priced line under the quantity deal row at the server's figures", () => {
    const summary = renderWith(tiered);
    expect(summary).toHaveTextContent("Quantity deal−Rp24,000");
    const note = summary.querySelector('[data-testid="tier-line-note"]')!;
    expect(note).toHaveTextContent("6 × Rp6,000");
    expect(note).toHaveTextContent("Rp36,000");
    expect(note).toHaveTextContent("Quantity deal: you save Rp24,000");
    expect(summary.querySelector('[data-testid="quote-changed"]')).toBeNull();
  });

  it("says the price changed, as a warning above the new figures, when asked to", () => {
    const summary = renderWith(tiered, true);
    const notice = summary.querySelector('[data-testid="quote-changed"]')!;
    expect(notice).toHaveAttribute("role", "alert");
    expect(notice).toHaveTextContent("The price changed");
    expect(notice).toHaveTextContent("nothing was charged");
  });

  it("shows no tier rows when nothing was discounted", () => {
    const summary = renderWith(totals);
    expect(summary.querySelector('[data-testid="tier-line-note"]')).toBeNull();
    expect(summary).not.toHaveTextContent("Quantity deal");
  });
});
