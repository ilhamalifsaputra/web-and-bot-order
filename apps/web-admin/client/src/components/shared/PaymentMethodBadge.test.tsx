import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaymentMethodBadge } from "./PaymentMethodBadge";

describe("PaymentMethodBadge", () => {
  it("renders the friendly label, not the raw enum", () => {
    render(<PaymentMethodBadge method="BINANCE_PAY" />);
    expect(screen.getByText("Binance Pay")).toBeInTheDocument();
    expect(screen.queryByText("BINANCE_PAY")).not.toBeInTheDocument();
  });

  it("groups crypto rails (Binance/Bybit) under the same tint", () => {
    const { container: binance } = render(<PaymentMethodBadge method="BINANCE_PAY" />);
    const { container: bybit } = render(<PaymentMethodBadge method="BYBIT" />);
    expect(binance.querySelector(".bg-pine-tint")).not.toBeNull();
    expect(bybit.querySelector(".bg-pine-tint")).not.toBeNull();
  });

  it("groups IDR gateway rails (TokoPay/PayDisini/NOWPayments) under the same tint", () => {
    const { container: tokopay } = render(<PaymentMethodBadge method="TOKOPAY" />);
    const { container: paydisini } = render(<PaymentMethodBadge method="PAYDISINI" />);
    expect(tokopay.querySelector(".bg-grass-tint")).not.toBeNull();
    expect(paydisini.querySelector(".bg-grass-tint")).not.toBeNull();
  });

  it("renders wallet/store-credit with a neutral tint", () => {
    const { container } = render(<PaymentMethodBadge method="WALLET" />);
    expect(screen.getByText("Store Credit")).toBeInTheDocument();
    expect(container.querySelector(".bg-sand")).not.toBeNull();
  });

  it("falls back to the raw string for an unmapped method without crashing", () => {
    render(<PaymentMethodBadge method="SOME_NEW_RAIL" />);
    expect(screen.getByText("SOME_NEW_RAIL")).toBeInTheDocument();
  });
});
