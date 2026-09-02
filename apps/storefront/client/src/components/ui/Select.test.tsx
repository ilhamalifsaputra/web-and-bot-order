import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import Select from "./Select";

describe("Select", () => {
  it("composes .field and renders option children", () => {
    render(
      <Select defaultValue="a" aria-label="pick">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    const el = screen.getByRole("combobox", { name: "pick" });
    expect(el).toHaveClass("field");
    expect(screen.getByRole("option", { name: "A" })).toBeInTheDocument();
  });

  it("invalid → border-rust + aria-invalid", () => {
    render(
      <Select invalid aria-label="pick" defaultValue="a">
        <option value="a">A</option>
      </Select>,
    );
    const el = screen.getByRole("combobox", { name: "pick" });
    expect(el).toHaveClass("border-rust");
    expect(el).toHaveAttribute("aria-invalid", "true");
  });

  it("forwards ref to the <select>", () => {
    const ref = createRef<HTMLSelectElement>();
    render(
      <Select ref={ref} defaultValue="a" aria-label="pick">
        <option value="a">A</option>
      </Select>,
    );
    expect(ref.current).toBeInstanceOf(HTMLSelectElement);
    expect(ref.current?.value).toBe("a");
  });
});
