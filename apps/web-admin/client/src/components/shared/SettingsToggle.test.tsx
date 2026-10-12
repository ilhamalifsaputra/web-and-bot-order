import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsToggle } from "./SettingsToggle";

describe("SettingsToggle", () => {
  it("names the switch and exposes ON/OFF with boolean changes", () => {
    const change = vi.fn();
    const view = render(<SettingsToggle id="mail" label="Email notifications" checked onCheckedChange={change} />);
    const toggle = screen.getByRole("switch", { name: "Email notifications" });
    expect(toggle).toBeChecked();
    expect(screen.getByText("ON")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(change).toHaveBeenCalledWith(false);
    view.rerender(<SettingsToggle id="mail" label="Email notifications" checked={false} onCheckedChange={change} />);
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("OFF")).toBeInTheDocument();
  });

  it("blocks changes while saving and explains a disabled control", () => {
    const change = vi.fn();
    render(<SettingsToggle id="reset" label="Password reset" checked pending disabledReason="Required for account recovery." onCheckedChange={change} />);
    const toggle = screen.getByRole("switch", { name: "Password reset" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-busy", "true");
    expect(toggle).toHaveAccessibleDescription("Required for account recovery.");
    fireEvent.click(toggle);
    expect(change).not.toHaveBeenCalled();
  });
});
