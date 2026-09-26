import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Checkbox } from "./checkbox";
import { Select, SelectTrigger, SelectValue } from "./select";

// jsdom cannot compute colours, so these guard the class names and the token
// value instead: a field must use the dedicated border token and a solid fill,
// and that token must not regress to the faint page-divider grey.
describe("form field contrast guards", () => {
  it("Input and Textarea use border-input with a solid fill", () => {
    const { container } = render(
      <>
        <Input />
        <Textarea />
      </>,
    );
    for (const el of Array.from(container.children)) {
      expect(el).toHaveClass("border-input", "bg-card");
      expect(el).not.toHaveClass("bg-transparent");
    }
  });

  it("SelectTrigger uses border-input with a solid fill", () => {
    const { getByRole } = render(
      <Select>
        <SelectTrigger aria-label="x">
          <SelectValue />
        </SelectTrigger>
      </Select>,
    );
    const el = getByRole("combobox");
    expect(el).toHaveClass("border-input", "bg-card");
    expect(el).not.toHaveClass("bg-transparent");
  });

  it("Checkbox uses border-input", () => {
    const { getByRole } = render(<Checkbox aria-label="x" />);
    expect(getByRole("checkbox")).toHaveClass("border-input");
  });

  it("--input token is darker than the faint --border divider colour", () => {
    const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
    const input = /--input:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1]?.toLowerCase();
    expect(input).toBeDefined();
    expect(input).not.toBe("#e3e8ef");
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = 1.05 / (lum(input!) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(2);
  });
});
