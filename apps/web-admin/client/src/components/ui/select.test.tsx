import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("Select", () => {
  it("keeps the item focus highlight distinct from the panel fill", async () => {
    const user = userEvent.setup();
    render(
      <Select defaultValue="a">
        <SelectTrigger aria-label="Pick one">
          <SelectValue />
        </SelectTrigger>
        <SelectContent data-testid="select-content">
          <SelectItem value="a">Option A</SelectItem>
          <SelectItem value="b">Option B</SelectItem>
        </SelectContent>
      </Select>,
    );

    await user.click(screen.getByRole("combobox", { name: "Pick one" }));

    const panel = await screen.findByTestId("select-content");
    const option = await screen.findByRole("option", { name: "Option B" });

    // Regression guard: the panel fill (bg-sand) and the item's focus highlight
    // (bg-pine-tint) must never collapse onto the same token again — that
    // collision made hover/keyboard-navigation feedback invisible.
    expect(panel).toHaveClass("bg-sand");
    expect(panel).not.toHaveClass("focus:bg-pine-tint");
    expect(option).toHaveClass("focus:bg-pine-tint");
    expect(option).not.toHaveClass("bg-sand");
    expect(option).not.toHaveClass("focus:bg-accent");
  });
});
