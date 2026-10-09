import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PaymentMarks from "./PaymentMarks";

describe("PaymentMarks", () => {
  it("renders nothing when methods are undefined or both flags are off", () => {
    const a = render(<PaymentMarks methods={undefined} />);
    expect(a.container).toBeEmptyDOMElement();
    const b = render(<PaymentMarks methods={{ qris: false, card: false }} />);
    expect(b.container).toBeEmptyDOMElement();
  });

  it("renders only the QRIS badge when only qris is on", () => {
    render(<PaymentMarks methods={{ qris: true, card: false }} />);
    expect(screen.getByRole("img", { name: "QRIS" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Visa" })).not.toBeInTheDocument();
  });

  it("renders the three card marks when only card is on", () => {
    render(<PaymentMarks methods={{ qris: false, card: true }} />);
    for (const name of ["Visa", "Mastercard", "JCB"]) {
      expect(screen.getByRole("img", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("img", { name: "QRIS" })).not.toBeInTheDocument();
  });

  it("renders everything when both are on", () => {
    render(<PaymentMarks methods={{ qris: true, card: true }} />);
    expect(screen.getAllByRole("img")).toHaveLength(4);
  });
});
