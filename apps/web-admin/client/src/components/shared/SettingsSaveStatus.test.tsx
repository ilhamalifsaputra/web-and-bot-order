import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSaveStatus } from "./SettingsSaveStatus";
import type { FieldSaveStatus } from "@/hooks/useSettings";

describe("SettingsSaveStatus", () => {
  it("renders nothing when nothing has ever been saved this session", () => {
    const { container } = render(
      <SettingsSaveStatus fieldStatuses={new Map()} lastSavedAt={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows 'Saving…' when any field is mid-save, even if another is editing", () => {
    const statuses = new Map<string, FieldSaveStatus>([
      ["shop_name", "editing"],
      ["bot_token", "saving"],
    ]);
    render(<SettingsSaveStatus fieldStatuses={statuses} lastSavedAt={null} />);
    expect(screen.getByText("Saving…")).toBeInTheDocument();
  });

  it("shows 'Unsaved changes' when a field is being edited and nothing is saving", () => {
    const statuses = new Map<string, FieldSaveStatus>([["shop_name", "editing"]]);
    render(<SettingsSaveStatus fieldStatuses={statuses} lastSavedAt={null} />);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("shows a relative 'Saved... ago' just after a save, decaying to 'All changes saved'", () => {
    render(<SettingsSaveStatus fieldStatuses={new Map()} lastSavedAt={Date.now()} />);
    expect(screen.getByText(/Saved just now/)).toBeInTheDocument();

    render(
      <SettingsSaveStatus fieldStatuses={new Map()} lastSavedAt={Date.now() - 5 * 60 * 1000} />,
    );
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });
});
