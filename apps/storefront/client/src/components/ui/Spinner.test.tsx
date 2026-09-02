import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import Spinner from "./Spinner";

describe("Spinner", () => {
  it("renders a decorative spinning ring", () => {
    const { container } = render(<Spinner />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("SPAN");
    expect(el).toHaveClass("animate-spin", "rounded-full", "border-2");
    expect(el).toHaveAttribute("aria-hidden", "true");
  });
});
