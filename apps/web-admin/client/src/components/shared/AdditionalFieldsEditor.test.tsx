import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdditionalFieldsEditor } from "./AdditionalFieldsEditor";
import { emptyFieldDraft } from "../../lib/additionalFields";
import type { AdditionalFieldDraft } from "../../api/types";

beforeEach(() => {
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them (same mocks as DenominationCreatePage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("AdditionalFieldsEditor", () => {
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

  it("clicking + Add Field appends a blank draft row", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    render(<AdditionalFieldsEditor value={[]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /add field/i }));
    expect(onChange).toHaveBeenCalledWith([emptyFieldDraft()]);
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
    render(<AdditionalFieldsEditor value={drafts} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. game id/i), { target: { value: "Server ID" } });
    expect(onChange).toHaveBeenCalledWith([{ ...emptyFieldDraft(), labelEn: "Server ID" }]);
  });

  it("toggling the required checkbox reports the flipped value via onChange", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    const drafts: AdditionalFieldDraft[] = [{ ...emptyFieldDraft(), key: "ign", required: true }];
    render(<AdditionalFieldsEditor value={drafts} onChange={onChange} />);
    await user.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith([{ ...drafts[0], required: false }]);
  });

  it("shows the options input only when the row's type is select", () => {
    const drafts: AdditionalFieldDraft[] = [{ ...emptyFieldDraft(), key: "server" }];
    const { rerender } = render(<AdditionalFieldsEditor value={drafts} onChange={vi.fn()} />);
    expect(screen.queryByPlaceholderText(/comma-separated/i)).not.toBeInTheDocument();

    rerender(<AdditionalFieldsEditor value={[{ ...drafts[0]!, type: "select" }]} onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText(/comma-separated/i)).toBeInTheDocument();
  });
});
