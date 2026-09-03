import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PaymentMethodSelector from "./PaymentMethodSelector";
import type { CheckoutData } from "../../api/types";

// Minimal fixture with all three groups showing at once (idr + crypto +
// sufficient wallet credit), so all three role="group" wrappers render in
// one pass.
const data: CheckoutData = {
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
  paydisini_enabled: false,
  nowpayments_enabled: false,
  wallet_idr: "500000",
  wallet_usdt: "0",
  wallet_idr_enabled: true,
  wallet_usdt_enabled: true,
  is_guest: false,
};

function renderSelector(overrides: Partial<CheckoutData> = {}) {
  return render(
    <MemoryRouter>
      <PaymentMethodSelector data={{ ...data, ...overrides }} method="qris" onSelect={() => {}} />
    </MemoryRouter>,
  );
}

describe("PaymentMethodSelector", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  // Task 13 review (Important): tabbing through the 8 radios previously gave
  // a screen-reader user no group context. Each group wrapper now has
  // role="group" + aria-labelledby pointing at its own field-label heading's
  // id — this only checks the wiring, not which rows/order/gates render
  // (unchanged from before this fix).
  it("labels each visible payment group for assistive tech", () => {
    renderSelector();

    const idrGroup = screen.getByRole("group", { name: "QRIS & e-wallet" });
    expect(idrGroup).toHaveAttribute("aria-labelledby", "payment-group-idr");
    expect(document.getElementById("payment-group-idr")).toHaveTextContent("QRIS & e-wallet");

    const cryptoGroup = screen.getByRole("group", { name: "Cryptocurrency" });
    expect(cryptoGroup).toHaveAttribute("aria-labelledby", "payment-group-crypto");

    const walletGroup = screen.getByRole("group", { name: "Wallet credit" });
    expect(walletGroup).toHaveAttribute("aria-labelledby", "payment-group-wallet");
  });

  it("omits a group's role=\"group\" wrapper entirely when its gate is off", () => {
    renderSelector({
      idr_enabled: false,
      paydisini_enabled: false,
      wallet_idr: "0",
      wallet_usdt_enabled: false,
    });
    expect(screen.queryByRole("group", { name: "QRIS & e-wallet" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Wallet credit" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Cryptocurrency" })).toBeInTheDocument();
  });
});
