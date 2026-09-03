import "@testing-library/jest-dom";
import type { ComponentProps } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DenominationCard, { type DenominationCardData } from "./DenominationCard";

const AUTO: DenominationCardData = {
  id: 1,
  name: "5 Diamonds",
  duration_label: null,
  price: "5000",
  flash: null,
  available: 20,
  in_stock: true,
  delivery_type: "auto",
};

function renderCard(overrides: Partial<ComponentProps<typeof DenominationCard>> = {}) {
  return render(
    <DenominationCard d={AUTO} fx={null} lowThreshold={5} checked={false} onChange={() => {}} {...overrides} />,
  );
}

describe("DenominationCard", () => {
  it("uses the 8px radius surface (rounded-lg), not the 16px .card class", () => {
    renderCard();
    const label = screen.getByText("5 Diamonds").closest("label")!;
    expect(label.className).toContain("rounded-lg");
    expect(label.className).toContain("bg-card");
    expect(label.className).toContain("border-line");
    // The shared `.card` (16px radius) / `.card-pad` classes are no longer used.
    expect(label.className.split(/\s+/)).not.toContain("card");
    expect(label.className.split(/\s+/)).not.toContain("card-pad");
  });

  it("marks the selected state with a 2px pine border + focus ring and NO fill", () => {
    renderCard({ checked: true });
    const label = screen.getByText("5 Diamonds").closest("label")!;
    expect(label.className).toContain("border-2");
    expect(label.className).toContain("has-[:checked]:border-pine");
    expect(label.className).toContain("has-[:checked]:ring-2");
    // The old solid-colour wash is gone.
    expect(label.className).not.toContain("bg-pine-tint/40");
  });

  it("keeps the radio + data-* selection contract the picker logic depends on", () => {
    const onChange = vi.fn();
    renderCard({ checked: true, onChange });
    const radio = screen.getByRole("radio") as HTMLInputElement;
    expect(radio).toBeChecked();
    expect(radio.getAttribute("form")).toBe("buy-form");
    const label = radio.closest("label")!;
    expect(label.getAttribute("data-denom-id")).toBe("1");
    expect(label.getAttribute("data-price")).toBe("5000");
  });

  it("dims and disables a non-purchasable auto denomination", () => {
    renderCard({ d: { ...AUTO, available: 0, in_stock: false } });
    const radio = screen.getByRole("radio") as HTMLInputElement;
    expect(radio).toBeDisabled();
    expect(screen.getByText("5 Diamonds").closest("label")!.className).toContain("opacity-60");
  });

  // task-23 (Fase 12 audit follow-up): a non-auto (provider-backed) plan
  // used to render no availability signal at all — now it shows the plain
  // "Available" pill, while an auto plan still runs the numeric StockBadge
  // path (low-stock / out-of-stock branches a non-auto plan can never reach).
  describe("availability signal", () => {
    it("shows the Available pill for a non-auto denomination", () => {
      renderCard({ d: { ...AUTO, delivery_type: "manual_with_info", available: 0, in_stock: false } });
      const pill = screen.getByText("Available");
      expect(pill).toHaveClass("bg-grass-tint", "text-grass-dark-aa");
    });

    it("still renders the numeric StockBadge path for an auto denomination", () => {
      // available (3) <= lowThreshold (5) -> the low-stock "N left" branch.
      renderCard({ d: { ...AUTO, delivery_type: "auto", available: 3 } });
      expect(screen.getByText("3 left")).toBeInTheDocument();
      expect(screen.queryByText("Available")).not.toBeInTheDocument();
    });
  });

  // Fase 12: the per-product currency chip. iconKind is a per-render prop
  // (not part of DenominationCardData), resolved once for the whole product
  // and passed identically to every plan.
  describe("iconKind chip", () => {
    it("renders nothing extra when iconKind is undefined", () => {
      renderCard();
      const label = screen.getByText("5 Diamonds").closest("label")!;
      expect(label.querySelector("svg")).toBeNull();
    });

    it("renders nothing extra when iconKind is null", () => {
      renderCard({ iconKind: null });
      const label = screen.getByText("5 Diamonds").closest("label")!;
      expect(label.querySelector("svg")).toBeNull();
    });

    it.each([
      ["diamond", "lucide-gem"],
      ["coin", "lucide-coins"],
      ["key", "lucide-key-round"],
      ["card", "lucide-credit-card"],
      ["voucher", "lucide-ticket"],
    ] as const)("renders the %s icon", (kind, lucideClass) => {
      renderCard({ iconKind: kind });
      const label = screen.getByText("5 Diamonds").closest("label")!;
      expect(label.querySelector(`.${lucideClass}`)).toBeInTheDocument();
    });
  });

  // Regression guard: the icon chip must never disturb the radio/data-*
  // contract the product page's picker logic reads (task-17-brief.md).
  it("keeps the radio + data-* contract unchanged when an icon chip is shown", () => {
    const onChange = vi.fn();
    renderCard({ checked: true, onChange, iconKind: "diamond" });
    const radio = screen.getByRole("radio") as HTMLInputElement;
    expect(radio).toBeChecked();
    expect(radio.getAttribute("form")).toBe("buy-form");
    const label = radio.closest("label")!;
    expect(label.getAttribute("data-denom-id")).toBe("1");
    expect(label.getAttribute("data-price")).toBe("5000");
    expect(label.className).toContain("has-[:checked]:border-pine");
  });
});
