import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PasswordInput from "./PasswordInput";

describe("PasswordInput", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("starts masked and toggles to plain text and back (STO-015)", async () => {
    const user = userEvent.setup();
    render(<PasswordInput id="pw" name="pw" aria-label="Password" />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    expect(input.type).toBe("password");

    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.type).toBe("text");

    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input.type).toBe("password");
  });

  it("passes through standard input props (id/name/required/autoComplete)", () => {
    render(<PasswordInput id="pw2" name="pw2" required autoComplete="new-password" aria-label="Password" />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    expect(input.id).toBe("pw2");
    expect(input.name).toBe("pw2");
    expect(input.required).toBe(true);
    expect(input.autocomplete).toBe("new-password");
  });
});
