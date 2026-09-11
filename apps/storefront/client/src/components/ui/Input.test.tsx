import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import Input from "./Input";

describe("Input", () => {
  it("composes .field and has no aria-invalid when valid", () => {
    render(<Input placeholder="Email" />);
    const el = screen.getByPlaceholderText("Email");
    expect(el).toHaveClass("field");
    expect(el).not.toHaveClass("!border-rust");
    expect(el).not.toHaveAttribute("aria-invalid");
  });

  it("invalid → border-rust + aria-invalid=true", () => {
    render(<Input placeholder="Email" invalid />);
    const el = screen.getByPlaceholderText("Email");
    expect(el).toHaveClass("field", "!border-rust");
    expect(el).toHaveAttribute("aria-invalid", "true");
  });

  it("does not clobber a caller-set aria-invalid or aria-describedby", () => {
    render(<Input placeholder="Email" aria-invalid={false} aria-describedby="hint-1" />);
    const el = screen.getByPlaceholderText("Email");
    expect(el).toHaveAttribute("aria-invalid", "false");
    expect(el).toHaveAttribute("aria-describedby", "hint-1");
  });

  it("forwards ref and merges className / native props", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} className="mt-1" name="email" defaultValue="a@b.c" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current).toHaveClass("field", "mt-1");
    expect(ref.current?.name).toBe("email");
    expect(ref.current?.value).toBe("a@b.c");
  });
});
