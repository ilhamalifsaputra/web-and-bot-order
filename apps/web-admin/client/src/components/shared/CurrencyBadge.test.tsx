import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CurrencyBadge } from "./CurrencyBadge";

describe("CurrencyBadge", () => {
  it("renders 'USD' for a USD preference", () => {
    render(<CurrencyBadge currency="USD" />);
    expect(screen.getByText("USD")).toBeInTheDocument();
  });

  it("renders 'IDR' for an IDR preference", () => {
    render(<CurrencyBadge currency="IDR" />);
    expect(screen.getByText("IDR")).toBeInTheDocument();
  });

  it("renders 'Not set' (muted styling) when the preference is null", () => {
    render(<CurrencyBadge currency={null} />);
    expect(screen.getByText("Not set")).toBeInTheDocument();
  });

  it("gives USD and IDR distinct, non-muted tone classes from the null state", () => {
    const usd = render(<CurrencyBadge currency="USD" />);
    const usdClass = usd.getByText("USD").className;
    usd.unmount();

    const idr = render(<CurrencyBadge currency="IDR" />);
    const idrClass = idr.getByText("IDR").className;
    idr.unmount();

    const unset = render(<CurrencyBadge currency={null} />);
    const unsetClass = unset.getByText("Not set").className;

    expect(usdClass).not.toBe(unsetClass);
    expect(idrClass).not.toBe(unsetClass);
    expect(usdClass).not.toBe(idrClass);
  });
});
