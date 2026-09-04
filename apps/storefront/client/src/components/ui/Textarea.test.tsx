import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import Textarea from "./Textarea";

describe("Textarea", () => {
  it("composes .field", () => {
    render(<Textarea placeholder="Notes" />);
    expect(screen.getByPlaceholderText("Notes")).toHaveClass("field");
  });

  it("invalid → border-rust + aria-invalid", () => {
    render(<Textarea placeholder="Notes" invalid />);
    const el = screen.getByPlaceholderText("Notes");
    expect(el).toHaveClass("border-rust");
    expect(el).toHaveAttribute("aria-invalid", "true");
  });

  it("forwards ref to the <textarea>", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} rows={4} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
    expect(ref.current?.rows).toBe(4);
  });
});
