import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { AdditionalField } from "../../api/types";
import DeliveryFieldInput from "./DeliveryFieldInput";

const field: AdditionalField = { key: "player_id", label: { id: "ID Pemain", en: "Player ID" }, type: "number", required: true, options: [], placeholder: "", minLength: 3, helpText: "Find it in your profile." };
const props = { field, inputId: "player", value: "", onChange: () => {} };
describe("DeliveryFieldInput validation timing", () => {
  beforeEach(() => { document.documentElement.lang = "en"; });
  it("starts with neutral guidance and surfaces empty required errors after blur", () => {
    render(<DeliveryFieldInput {...props} />);
    const input = screen.getByLabelText("Player ID");
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Find it in your profile.")).toBeInTheDocument();
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", expect.stringContaining("player-error"));
  });
  it("does not show a constraint error while the buyer is still typing", () => {
    render(<DeliveryFieldInput {...props} value="1" />);
    expect(screen.getByLabelText("Player ID")).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.blur(screen.getByLabelText("Player ID"));
    expect(screen.getByLabelText("Player ID")).toHaveAttribute("aria-invalid", "true");
  });
  it("marks an optional select and permits an empty answer", () => {
    render(<DeliveryFieldInput {...props} field={{ ...field, key: "region", label: { id: "Wilayah", en: "Region" }, type: "select", required: false, options: ["Asia", "Europe"] }} />);
    const select = screen.getByLabelText("Region (Optional)");
    fireEvent.blur(select);
    expect(select).not.toHaveAttribute("aria-invalid", "true");
    expect(select).not.toBeRequired();
    expect(screen.getByRole("option", { name: "Asia" })).toBeInTheDocument();
  });
});
