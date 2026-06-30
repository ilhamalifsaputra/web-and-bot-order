import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Package } from "lucide-react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders the title", () => {
    render(<EmptyState title="No results found." />);
    expect(screen.getByText("No results found.")).toBeInTheDocument();
  });

  it("renders a description when provided", () => {
    render(<EmptyState title="Empty" description="Try adjusting your filters." />);
    expect(screen.getByText("Try adjusting your filters.")).toBeInTheDocument();
  });

  it("renders an action button and calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<EmptyState title="Empty" action={{ label: "Add item", onClick }} />);
    const btn = screen.getByRole("button", { name: "Add item" });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders an icon when provided", () => {
    render(<EmptyState icon={Package} title="No packages." />);
    expect(document.querySelector("svg")).toBeInTheDocument();
  });

  it("does not render an SVG when no icon is provided", () => {
    render(<EmptyState title="No packages." />);
    expect(document.querySelector("svg")).not.toBeInTheDocument();
  });

  it("supports legacy message prop for backwards compatibility", () => {
    render(<EmptyState message="Nothing to review." />);
    expect(screen.getByText("Nothing to review.")).toBeInTheDocument();
  });
});
