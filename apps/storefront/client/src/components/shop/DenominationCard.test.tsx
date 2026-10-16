import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DenominationCard, { type DenominationCardData } from "./DenominationCard";
import { apiGet } from "../../api/client";
import type { ShopContext } from "../../api/types";

// DenominationCard renders <Price/>, which (Task 5) reads the display-currency
// preference off the shared ["context"] query itself — needs the same
// QueryClientProvider wrapper the page tests already use. No currency-specific
// assertion in this file, so a static null-currency mock keeps every existing
// assertion's today's-default expectation unchanged.
vi.mock("../../api/client", () => ({
  apiGet: vi.fn(),
}));

const AUTO: DenominationCardData = {
  id: 1,
  name: "5 Diamonds",
  duration_label: null,
  price: "5000",
  flash: null,
  available: 20,
  in_stock: true,
  uses_local_inventory: true,
  purchasable: true,
  delivery_type: "auto",
};

const context: ShopContext = {
  lang: "en", fx: null, shop_name: "Test Shop", shop_tagline: "", cart_count: 0,
  customer: null, favicon_url: "/static/favicon.svg", logo_url: "", bot_username: null,
  wa_number: null, tzname: "Asia/Jakarta", currency: null,
};

function renderCard(overrides: Partial<ComponentProps<typeof DenominationCard>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Price reads the shared context query. Seed its complete response so a
  // synchronous card assertion cannot outlive a mock API promise settling.
  queryClient.setQueryData(["context"], context);
  return render(
    <QueryClientProvider client={queryClient}>
      <DenominationCard d={AUTO} fx={null} lowThreshold={5} checked={false} onChange={() => {}} {...overrides} />
    </QueryClientProvider>,
  );
}

describe("DenominationCard", () => {
  it("uses complete canonical meaning and backend exact text even when legacy fields differ", () => {
    const canonical = {
      id: 1, supplierSku: null, rawName: "Supplier full name", rawNameProvenance: "supplier" as const,
      displayName: "86 Diamonds + 8 Bonus Global via ID Promo", variant: { type: "unknown" as const, name: "86 Diamonds + 8 Bonus Global via ID Promo", residual: [] },
      qualifiers: ["Indonesia", "Server A"], product: { id: 3, name: "Mobile Legends", gameRegion: "Indonesia", gameVariant: null }, category: { id: 1, name: "Top Up", group: "GAME_TOPUP" },
      priceIDR: { currency: "IDR" as const, amountMinor: "210001254", scale: 4 }, displayPrice: { currency: "IDR" as const, amountMinor: "210001254", scale: 4 },
      formattedPrice: "Rp21.000,1254", currencyFallback: false, conversion: null,
      availability: { status: "available" as const, purchasable: true }, createdAt: null, generatedAt: "2026-09-30T00:00:00.000Z",
    };
    renderCard({ d: { ...AUTO, canonical } });
    expect(screen.getByText("86 Diamonds + 8 Bonus Global via ID Promo")).toBeInTheDocument();
    expect(screen.getByText("Indonesia · Server A")).toBeInTheDocument();
    expect(screen.getByText("Rp21.000,1254")).toBeInTheDocument();
    expect(screen.queryByText("5 Diamonds")).not.toBeInTheDocument();
  });
  beforeEach(() => {
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ currency: null, fx: null });
  });

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

  it("marks selection with a blue fill and border, with a separate keyboard focus ring", () => {
    renderCard({ checked: true });
    const label = screen.getByText("5 Diamonds").closest("label")!;
    expect(label.className).toContain("border-2");
    expect(label.className).toContain("has-[:checked]:border-pine");
    expect(label.className).toContain("has-[:checked]:bg-pine-tint");
    expect(label.className).toContain("focus-within:ring-2");
    expect(label.className).toContain("focus-within:ring-pine");
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
    renderCard({ d: { ...AUTO, available: 0, in_stock: false, purchasable: false } });
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
      renderCard({ d: { ...AUTO, delivery_type: "manual_with_info", available: 0, in_stock: false, uses_local_inventory: false, purchasable: true } });
      const pill = screen.getByText("Available");
      expect(pill).toHaveClass("bg-grass-tint", "text-grass-dark-aa");
    });

    it("still renders the numeric StockBadge path for an auto denomination", () => {
      // available (3) <= lowThreshold (5) -> the low-stock "N left" branch.
      renderCard({ d: { ...AUTO, delivery_type: "auto", available: 3 } });
      expect(screen.getByText("3 left")).toBeInTheDocument();
      expect(screen.queryByText("Available")).not.toBeInTheDocument();
    });

    it("an auto + provider plan with no stock rows is selectable and shows no stock count", () => {
      // delivery_type "auto" but the server says it is a provider SKU.
      renderCard({ d: { ...AUTO, delivery_type: "auto", available: 0, in_stock: false, uses_local_inventory: false, purchasable: true } });
      expect(screen.getByRole("radio")).not.toBeDisabled();
      expect(screen.getByText("Available")).toBeInTheDocument();
      expect(screen.queryByText(/left|Out of stock/i)).not.toBeInTheDocument();
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

  describe("layout", () => {
    it("default row layout keeps the two-column grid contract", () => {
      renderCard();
      const label = screen.getByText("5 Diamonds").closest("label")!;
      expect(label.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
      expect(label.className.split(/\s+/)).toContain("grid");
      expect(label.getAttribute("data-layout")).toBeNull();
    });

    it("stacked layout puts the name before the price and drops the row grid", () => {
      renderCard({ layout: "stacked" });
      const label = screen.getByText("5 Diamonds").closest("label")!;
      expect(label.className).not.toContain("grid-cols-");
      expect(label.className).toContain("flex-col");
      expect(label.className).toContain("min-h-11");
      const name = screen.getByText("5 Diamonds");
      const price = screen.getByText(/5[.,]000/);
      expect(name.compareDocumentPosition(price) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("stacked layout keeps the radio, selected styling, data-* and badges", () => {
      renderCard({ layout: "stacked", checked: true, iconKind: "diamond", d: { ...AUTO, available: 3 } });
      const radio = screen.getByRole("radio");
      expect(radio).toBeChecked();
      const label = radio.closest("label")!;
      expect(label.getAttribute("data-denom-id")).toBe("1");
      expect(label.className).toContain("has-[:checked]:border-pine");
      expect(label.className).toContain("focus-within:ring-pine");
      expect(label.querySelector(".lucide-gem")).toBeInTheDocument();
      expect(screen.getByText("3 left")).toBeInTheDocument();
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
