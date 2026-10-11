import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Package, ShoppingCart } from "lucide-react";
import StepTimeline, { type StepItem } from "./StepTimeline";

const steps: StepItem[] = [
  { id: "fixture-1", icon: Package, title: "Pick a product", description: "Choose a plan and duration." },
  { id: "fixture-2", icon: ShoppingCart, title: "Check out", description: "Add it to your cart." },
];

describe("StepTimeline", () => {
  it.each(["grid", "stacked"] as const)("keeps custom input state with its step after reordering in %s layout", layout => {
    const a = { id: "a", icon: Package, title: "Same title", description: <input aria-label="first" defaultValue="first" /> };
    const b = { id: "b", icon: Package, title: "Same title", description: <input aria-label="second" defaultValue="second" /> };
    const { rerender } = render(<StepTimeline layout={layout} steps={[a, b]} />);
    const input = screen.getByLabelText("first");
    fireEvent.change(input, { target: { value: "edited" } });
    rerender(<StepTimeline layout={layout} steps={[b, a]} />);
    expect(screen.getByLabelText("first")).toBe(input);
    expect(screen.getByLabelText("first")).toHaveValue("edited");
    expect(screen.getByLabelText("second")).toHaveValue("second");
  });

  it("renders one list item per step, each with a heading carrying the exact title", () => {
    const { container } = render(<StepTimeline steps={steps} />);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Pick a product" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Check out" })).toBeInTheDocument();
  });

  it("skips the heading when a step omits a title, using description as the full custom slot", () => {
    const custom: StepItem[] = [{ id: "fixture-3", icon: Package, description: <div data-testid="custom">Custom content</div> }];
    render(<StepTimeline steps={custom} />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByTestId("custom")).toBeInTheDocument();
  });

  it("renders the grid layout with the same step count and headings", () => {
    const { container } = render(<StepTimeline steps={steps} layout="grid" />);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Pick a product" })).toBeInTheDocument();
  });
});
