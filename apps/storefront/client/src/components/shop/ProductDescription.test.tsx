import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ProductDescription from "./ProductDescription";

const proto = HTMLElement.prototype;
const originalScrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
const originalClientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");

// jsdom has no layout, so fake how tall the content is versus the box.
function stubHeights(scrollHeight: number, clientHeight: number) {
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => clientHeight });
}

function restore(name: "scrollHeight" | "clientHeight", original?: PropertyDescriptor) {
  if (original) Object.defineProperty(proto, name, original);
  else delete (proto as unknown as Record<string, unknown>)[name];
}

afterEach(() => {
  restore("scrollHeight", originalScrollHeight);
  restore("clientHeight", originalClientHeight);
});

describe("ProductDescription", () => {
  it("shows no toggle when the text fits", () => {
    stubHeights(60, 60);
    render(<ProductDescription text="Short text" />);
    expect(screen.getByText("Short text")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps whitespace and the caller's spacing class on the text", () => {
    stubHeights(60, 60);
    render(<ProductDescription text="Line one" className="mt-4" />);
    const text = screen.getByText("Line one");
    expect(text).toHaveClass("whitespace-pre-line", "text-sm", "text-ink-soft", "mt-4");
  });

  // In a real browser the clamp is removed when expanded, so scrollHeight ==
  // clientHeight; the "Show less" control must not disappear because of that.
  it("keeps 'Show less' visible after expanding even when the measured heights become equal", () => {
    stubHeights(200, 60);
    render(<ProductDescription text="A very long description" />);
    const button = screen.getByRole("button", { name: "Read more" });
    stubHeights(60, 60);
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("toggles between clamped and expanded when truncated", () => {
    stubHeights(200, 60);
    render(<ProductDescription text="A very long description" />);
    const text = screen.getByText("A very long description");
    const button = screen.getByRole("button", { name: "Read more" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(text).toHaveClass("line-clamp-3", "md:line-clamp-none");

    fireEvent.click(button);
    const less = screen.getByRole("button", { name: "Show less" });
    expect(less).toHaveAttribute("aria-expanded", "true");
    expect(text).not.toHaveClass("line-clamp-3");

    fireEvent.click(less);
    expect(screen.getByRole("button", { name: "Read more" })).toHaveAttribute("aria-expanded", "false");
    expect(text).toHaveClass("line-clamp-3", "md:line-clamp-none");
  });

  it("hides the toggle from md up and keeps a 44px tap target", () => {
    stubHeights(200, 60);
    render(<ProductDescription text="Long" />);
    const button = screen.getByRole("button");
    expect(button).toHaveClass("md:hidden", "min-h-11");
    expect(button).toHaveAttribute("type", "button");
  });

  it("points aria-controls at the text element", () => {
    stubHeights(200, 60);
    render(<ProductDescription text="Long text" />);
    const button = screen.getByRole("button");
    const text = screen.getByText("Long text");
    expect(text.id).not.toBe("");
    expect(button).toHaveAttribute("aria-controls", text.id);
  });

  it("resets to collapsed when keyed by a new text", () => {
    stubHeights(200, 60);
    const { rerender } = render(<ProductDescription key="a" text="First" />);
    fireEvent.click(screen.getByRole("button", { name: "Read more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();

    rerender(<ProductDescription key="b" text="Second" />);
    expect(screen.getByRole("button", { name: "Read more" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Second")).toHaveClass("line-clamp-3");
  });
});
