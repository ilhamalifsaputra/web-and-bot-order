import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Price from "./Price";

describe("Price", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("renders the IDR figure and the derived USDT hint when fx is set", () => {
    render(<Price value="79000" fx="16000" />);
    expect(screen.getByText("Rp79.000")).toBeInTheDocument();
    expect(screen.getByText("≈ $4.90")).toBeInTheDocument();
  });

  it("hides the USDT hint when fx is null", () => {
    render(<Price value="79000" fx={null} />);
    expect(screen.getByText("Rp79.000")).toBeInTheDocument();
    expect(screen.queryByText(/≈ \$/)).not.toBeInTheDocument();
  });
});
