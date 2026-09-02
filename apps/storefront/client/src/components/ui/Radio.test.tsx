import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import Radio from "./Radio";

describe("Radio", () => {
  it("renders a native radio with name/value passed through", () => {
    render(<Radio name="tier" value="pro" aria-label="Pro" />);
    const el = screen.getByRole("radio", { name: "Pro" });
    expect(el).toHaveAttribute("type", "radio");
    expect(el).toHaveAttribute("name", "tier");
    expect(el).toHaveAttribute("value", "pro");
    expect(el).toHaveClass("h-4", "w-4");
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Radio ref={ref} name="tier" value="a" aria-label="a" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });
});
