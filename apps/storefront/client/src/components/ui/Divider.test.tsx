import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import Divider from "./Divider";

describe("Divider", () => {
  it("renders a horizontal <hr> separator by default", () => {
    render(<Divider />);
    const el = screen.getByRole("separator");
    expect(el.tagName).toBe("HR");
    expect(el).toHaveAttribute("aria-orientation", "horizontal");
    expect(el).toHaveClass("border-t", "border-line");
  });

  it("orientation=vertical switches the border side + aria-orientation", () => {
    render(<Divider orientation="vertical" />);
    const el = screen.getByRole("separator");
    expect(el).toHaveAttribute("aria-orientation", "vertical");
    expect(el).toHaveClass("border-l", "self-stretch");
    expect(el).not.toHaveClass("border-t");
  });

  it("forwards ref and merges className", () => {
    const ref = createRef<HTMLHRElement>();
    render(<Divider ref={ref} className="my-4" />);
    expect(ref.current).toBeInstanceOf(HTMLHRElement);
    expect(ref.current).toHaveClass("my-4");
  });
});
