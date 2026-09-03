import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import StickyPurchaseBar from "./StickyPurchaseBar";

describe("StickyPurchaseBar", () => {
  it("renders the price label, price and primary CTA", () => {
    render(
      <StickyPurchaseBar
        priceLabel="1 Month"
        price="Rp79.000"
        primaryAction={{ label: "Buy now", onClick: () => {} }}
      />,
    );
    expect(screen.getByText("1 Month")).toBeInTheDocument();
    expect(screen.getByText("Rp79.000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy now" })).toBeInTheDocument();
  });

  it("fires the primary action's onClick", () => {
    const onClick = vi.fn();
    render(<StickyPurchaseBar price="Rp10.000" primaryAction={{ label: "Buy now", onClick }} />);
    fireEvent.click(screen.getByRole("button", { name: "Buy now" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disables the primary button and shows a spinner when pending + disabled", () => {
    const onClick = vi.fn();
    render(
      <StickyPurchaseBar
        price="Rp10.000"
        primaryAction={{ label: "Buy now", onClick, pending: true, disabled: true }}
      />,
    );
    const button = screen.getByRole("button", { name: /Buy now/ });
    expect(button).toBeDisabled();
    // components/ui/Spinner is an aria-hidden span with the animate-spin class.
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("mutes (but does not spin) the primary button when blocked", () => {
    render(
      <StickyPurchaseBar
        price="Rp10.000"
        primaryAction={{ label: "Buy now", onClick: () => {}, blocked: true, disabled: true }}
      />,
    );
    const button = screen.getByRole("button", { name: "Buy now" });
    expect(button.className).toContain("opacity-60");
    expect(button.querySelector(".animate-spin")).toBeNull();
  });

  it("renders the notice ribbon and the savings / secondary chips only when passed", () => {
    const { rerender } = render(
      <StickyPurchaseBar price="Rp10.000" primaryAction={{ label: "Buy now", onClick: () => {} }} />,
    );
    expect(screen.queryByText("Hemat Rp2.000")).not.toBeInTheDocument();

    rerender(
      <StickyPurchaseBar
        price="Rp10.000"
        notice="Beli 3 hemat 10%"
        savingsChip={<span>Hemat Rp2.000</span>}
        secondaryChip={<span>Diskon grosir</span>}
        primaryAction={{ label: "Buy now", onClick: () => {} }}
      />,
    );
    expect(screen.getByText("Beli 3 hemat 10%")).toBeInTheDocument();
    expect(screen.getByText("Hemat Rp2.000")).toBeInTheDocument();
    expect(screen.getByText("Diskon grosir")).toBeInTheDocument();
  });

  it("supports a two-action case, rendering the secondary CTA before the primary", () => {
    const primary = vi.fn();
    const secondary = vi.fn();
    render(
      <StickyPurchaseBar
        price="Rp10.000"
        primaryAction={{ label: "Buy now", onClick: primary }}
        secondaryAction={{ label: "Add to cart", onClick: secondary, variant: "soft" }}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Add to cart", "Buy now"]);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    expect(secondary).toHaveBeenCalledTimes(1);
    expect(primary).not.toHaveBeenCalled();
  });

  it("exposes a labelled region landmark only when ariaLabel is given", () => {
    const { rerender } = render(
      <StickyPurchaseBar price="Rp10.000" primaryAction={{ label: "Buy now", onClick: () => {} }} />,
    );
    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    rerender(
      <StickyPurchaseBar
        ariaLabel="Purchase"
        price="Rp10.000"
        primaryAction={{ label: "Buy now", onClick: () => {} }}
      />,
    );
    expect(screen.getByRole("region", { name: "Purchase" })).toBeInTheDocument();
  });
});
