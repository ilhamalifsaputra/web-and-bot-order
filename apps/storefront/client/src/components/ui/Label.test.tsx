import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import Label from "./Label";

describe("Label", () => {
  it("composes .field-label and passes htmlFor through", () => {
    render(<Label htmlFor="email">Email</Label>);
    const el = screen.getByText("Email");
    expect(el.tagName).toBe("LABEL");
    expect(el).toHaveClass("field-label");
    expect(el).toHaveAttribute("for", "email");
  });

  it("required renders a rust, aria-hidden * plus an sr-only '(required)'", () => {
    const { container } = render(<Label required>Email</Label>);
    const marker = container.querySelector("span[aria-hidden='true']");
    expect(marker).not.toBeNull();
    expect(marker).toHaveTextContent("*");
    expect(marker).toHaveClass("text-rust");
    expect(screen.getByText("(required)", { exact: false })).toHaveClass("sr-only");
  });

  it("omits the marker when not required", () => {
    const { container } = render(<Label>Email</Label>);
    expect(container.querySelector("span[aria-hidden='true']")).toBeNull();
    expect(screen.queryByText("(required)", { exact: false })).not.toBeInTheDocument();
  });

  it("forwards ref to the <label>", () => {
    const ref = createRef<HTMLLabelElement>();
    render(<Label ref={ref}>Email</Label>);
    expect(ref.current).toBeInstanceOf(HTMLLabelElement);
  });
});
