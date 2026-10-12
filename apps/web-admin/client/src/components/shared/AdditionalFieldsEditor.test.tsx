import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdditionalFieldDraft } from "../../api/types";
import { emptyFieldDraft } from "../../lib/additionalFields";
import { AdditionalFieldsEditor } from "./AdditionalFieldsEditor";

beforeEach(() => {
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them (same mocks as DenominationCreatePage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("AdditionalFieldsEditor", () => {
  it("adds a field with a local identity when randomUUID is unavailable on plain HTTP", () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const onChange = vi.fn();
      render(<AdditionalFieldsEditor value={[]} onChange={onChange} />);
      fireEvent.click(screen.getByRole("button", { name: /add field/i }));
      expect(onChange).toHaveBeenCalledTimes(1);
      const [draft] = onChange.mock.calls[0]![0] as AdditionalFieldDraft[];
      expect(draft?.draftId).toMatch(/^draft:\d+$/);
      expect(draft?.key).toBe("");
    } finally {
      if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
      else Reflect.deleteProperty(crypto, "randomUUID");
    }
  });

  it("preserves the remaining draft's input and focus when an earlier row is removed", () => {
    const first = emptyFieldDraft();
    const second = { ...emptyFieldDraft(), labelEn: "Account email" };
    const onChange = vi.fn();
    const view = render(<AdditionalFieldsEditor value={[first, second]} onChange={onChange} />);
    const input = screen.getByDisplayValue("Account email");
    input.focus();
    view.rerender(<AdditionalFieldsEditor value={[second]} onChange={onChange} />);
    expect(screen.getByDisplayValue("Account email")).toBe(input);
    expect(input).toHaveFocus();
    expect(first.draftId).not.toBe(second.draftId);
  });

  it("renders no field rows and an Add Field button when value is empty", () => {
    render(<AdditionalFieldsEditor value={[]} onChange={vi.fn()} />);
    expect(screen.queryAllByPlaceholderText(/e\.g\. id game/i)).toHaveLength(0);
    expect(screen.getByRole("button", { name: /add field/i })).toBeInTheDocument();
  });

  it("renders one row per draft, showing the current labels/placeholder", () => {
    const drafts: AdditionalFieldDraft[] = [
      { key: "ign", labelId: "IGN", labelEn: "In-game name", type: "text", required: true, optionsText: "", placeholder: "e.g. Shadow123" },
      { key: "email", labelId: "Email", labelEn: "Email", type: "email", required: false, optionsText: "", placeholder: "" },
    ];
    render(<AdditionalFieldsEditor value={drafts} onChange={vi.fn()} />);
    expect(screen.getByDisplayValue("IGN")).toBeInTheDocument();
    expect(screen.getByDisplayValue("In-game name")).toBeInTheDocument();
    expect(screen.getByDisplayValue("e.g. Shadow123")).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("Email")).toHaveLength(2);
  });

  it("shows Game Top Up examples for a game and Premium Apps examples otherwise (default is not game)", () => {
    const drafts: AdditionalFieldDraft[] = [{ ...emptyFieldDraft(), key: "id" }];
    const { rerender } = render(<AdditionalFieldsEditor isGame value={drafts} onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText("e.g. ID Game")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. 1023849571")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. Email akun")).not.toBeInTheDocument();

    // Omitting the prop must never leak game examples into a Premium Apps form.
    rerender(<AdditionalFieldsEditor value={drafts} onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText("e.g. Email akun")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. buyer@example.com")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. ID Game")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. 1023849571")).not.toBeInTheDocument();
  });

  it("clicking + Add Field appends a blank draft row", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    render(<AdditionalFieldsEditor value={[]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /add field/i }));
    expect(onChange).toHaveBeenCalledWith([{ ...emptyFieldDraft(), draftId: expect.any(String) }]);
  });

  it("clicking Remove on a row removes only that row", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    const drafts: AdditionalFieldDraft[] = [
      { ...emptyFieldDraft(), key: "first" },
      { ...emptyFieldDraft(), key: "second" },
    ];
    render(<AdditionalFieldsEditor value={drafts} onChange={onChange} />);
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    await user.click(removeButtons[0]!);
    expect(onChange).toHaveBeenCalledWith([drafts[1]]);
  });

  it("typing in a row's English question input reports the updated draft via onChange", () => {
    const onChange = vi.fn();
    const drafts: AdditionalFieldDraft[] = [{ ...emptyFieldDraft(), labelEn: "" }];
    render(<AdditionalFieldsEditor isGame value={drafts} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. game id/i), { target: { value: "Server ID" } });
    expect(onChange).toHaveBeenCalledWith([{ ...drafts[0], labelEn: "Server ID" }]);
  });

  it("toggling the required switch reports the flipped value via onChange", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    const drafts: AdditionalFieldDraft[] = [{ ...emptyFieldDraft(), key: "ign", required: true }];
    render(<AdditionalFieldsEditor value={drafts} onChange={onChange} />);
    await user.click(screen.getByRole("switch", { name: "Required" }));
    expect(onChange).toHaveBeenCalledWith([{ ...drafts[0], required: false }]);
  });

  it("shows the options input only when the row's type is select", () => {
    const drafts: AdditionalFieldDraft[] = [{ ...emptyFieldDraft(), key: "server" }];
    const { rerender } = render(<AdditionalFieldsEditor value={drafts} onChange={vi.fn()} />);
    expect(screen.queryByPlaceholderText(/comma-separated/i)).not.toBeInTheDocument();

    rerender(<AdditionalFieldsEditor value={[{ ...drafts[0]!, type: "select" }]} onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText(/comma-separated/i)).toBeInTheDocument();
  });
  it("preserves the remaining input element when a preceding draft is removed", () => {
    const first = { ...emptyFieldDraft(), draftId: "first", labelEn: "First" };
    const second = { ...emptyFieldDraft(), draftId: "second", labelEn: "Second" };
    const { rerender } = render(<AdditionalFieldsEditor value={[first, second]} onChange={vi.fn()} />);
    const input = screen.getByDisplayValue("Second");
    rerender(<AdditionalFieldsEditor value={[second]} onChange={vi.fn()} />);
    expect(screen.getByDisplayValue("Second")).toBe(input);
  });

});
