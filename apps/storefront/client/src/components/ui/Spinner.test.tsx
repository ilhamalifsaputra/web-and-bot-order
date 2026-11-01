import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import Spinner from "./Spinner";

describe("Spinner", () => {
  it("renders a decorative spinning ring", () => {
    const { container } = render(<Spinner />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("SPAN");
    expect(el).toHaveClass("motion-safe:animate-spin", "rounded-full", "border-2");
    // Reduced motion: no rotation class applies, the ring stays still.
    expect(el).not.toHaveClass("animate-spin");
    expect(el).toHaveAttribute("aria-hidden", "true");
  });
});
