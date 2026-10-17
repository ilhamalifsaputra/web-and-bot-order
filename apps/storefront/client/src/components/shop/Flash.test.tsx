import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import Flash from "./Flash";

/**
 * Flash is a compat shim over <Alert variant="banner">. These assertions pin
 * the wrapper, content and icons while inheriting the shared semantic tones.
 */
describe("Flash (Alert shim)", () => {
  it("renders nothing without text", () => {
    const { container } = render(<Flash text={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("info (default) keeps the wrapper and uses the shared guidance tone", () => {
    const { container } = render(<Flash text="Heads up" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toBe(
      "flex items-start gap-2 rounded-xl px-4 py-3 mb-5 text-sm border bg-pine-tint text-pine-dark border-pine/30",
    );
    expect(el).not.toHaveAttribute("role");
    expect(el.querySelector("span")).toHaveTextContent("Heads up");
    expect(el.querySelector("svg")).toHaveClass("w-4", "h-4", "shrink-0", "mt-px");
  });

  it("error tone matches the old rust classes and icon", () => {
    const { container } = render(<Flash text="Bad input" kind="error" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toBe(
      "flex items-start gap-2 rounded-xl px-4 py-3 mb-5 text-sm border bg-rust-tint text-rust-dark border-rust/30",
    );
    expect(el.querySelector("svg.lucide-triangle-alert")).toBeInTheDocument();
  });

  it("success keeps its green surface and icon with readable body text", () => {
    const { container } = render(<Flash text="Saved" kind="success" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toBe(
      "flex items-start gap-2 rounded-xl px-4 py-3 mb-5 text-sm border bg-grass-tint text-ink-soft border-grass/30",
    );
    expect(el.querySelector("svg.lucide-circle-check-big")).toBeInTheDocument();
  });
});
