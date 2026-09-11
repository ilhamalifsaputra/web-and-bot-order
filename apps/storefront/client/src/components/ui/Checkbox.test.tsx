import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import Checkbox from "./Checkbox";

describe("Checkbox", () => {
  it("renders a native checkbox and merges className", () => {
    render(<Checkbox className="mr-2" aria-label="agree" />);
    const el = screen.getByRole("checkbox", { name: "agree" });
    expect(el).toHaveAttribute("type", "checkbox");
    expect(el).toHaveClass("h-4", "w-4", "mr-2");
  });

  it("forwards ref and fires onChange", () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(<Checkbox ref={ref} onChange={onChange} aria-label="agree" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("respects the disabled prop", () => {
    render(<Checkbox disabled aria-label="agree" />);
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
});
