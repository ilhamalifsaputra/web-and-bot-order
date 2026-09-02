import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Switch from "./Switch";

describe("Switch", () => {
  it("is a role=switch button reporting aria-checked and its accessible name", () => {
    render(<Switch checked={false} onCheckedChange={() => {}} aria-label="Notifications" />);
    const el = screen.getByRole("switch", { name: "Notifications" });
    expect(el.tagName).toBe("BUTTON");
    expect(el).toHaveAttribute("type", "button");
    expect(el).toHaveAttribute("aria-checked", "false");
    expect(el).toHaveClass("bg-sand");
  });

  it("reflects the on state", () => {
    render(<Switch checked onCheckedChange={() => {}} aria-label="x" />);
    const el = screen.getByRole("switch");
    expect(el).toHaveAttribute("aria-checked", "true");
    expect(el).toHaveClass("bg-pine");
  });

  it("click toggles: calls onCheckedChange with the negated value", () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="x" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("toggles from the keyboard (Space)", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="x" />);
    await user.tab();
    expect(screen.getByRole("switch")).toHaveFocus();
    await user.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("does not toggle when disabled", () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch checked={false} disabled onCheckedChange={onCheckedChange} aria-label="x" />,
    );
    const el = screen.getByRole("switch");
    expect(el).toBeDisabled();
    fireEvent.click(el);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("forwards ref to the button", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Switch ref={ref} checked={false} onCheckedChange={() => {}} aria-label="x" />);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});
