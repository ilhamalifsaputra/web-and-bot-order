import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Zap, Shield } from "lucide-react";
import TrustBadgeRow, { type TrustBadge } from "./TrustBadgeRow";

const ITEMS: TrustBadge[] = [
  { icon: <Zap data-testid="icon-zap" className="h-4 w-4 text-grass" />, label: "Instant delivery" },
  { icon: <Shield data-testid="icon-shield" className="h-4 w-4 text-grass" />, label: "QRIS & USDT" },
];

describe("TrustBadgeRow", () => {
  it("renders one list item per badge, with its label and icon", () => {
    render(<TrustBadgeRow items={ITEMS} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.getByText("Instant delivery")).toBeInTheDocument();
    expect(screen.getByText("QRIS & USDT")).toBeInTheDocument();
    expect(screen.getByTestId("icon-zap")).toBeInTheDocument();
    expect(screen.getByTestId("icon-shield")).toBeInTheDocument();
  });

  it("lays out as a wrapping row by default and a stack when orientation='column'", () => {
    const { rerender } = render(<TrustBadgeRow items={ITEMS} />);
    expect(screen.getByRole("list").className).toContain("flex-wrap");

    rerender(<TrustBadgeRow items={ITEMS} orientation="column" />);
    expect(screen.getByRole("list").className).toContain("space-y-3");
    expect(screen.getByRole("list").className).not.toContain("flex-wrap");
  });

  it("forwards className onto the list (surface chrome is the caller's job)", () => {
    render(<TrustBadgeRow items={ITEMS} className="mt-8 border-t border-white/10 pt-5 text-ink-faint" />);
    const list = screen.getByRole("list");
    expect(list.className).toContain("border-t");
    expect(list.className).toContain("text-ink-faint");
  });

  it("is business-agnostic — renders with no router/query/i18n provider", () => {
    // The render calls above already prove this (no wrappers); this pins it.
    expect(() => render(<TrustBadgeRow items={[]} />)).not.toThrow();
  });
});
