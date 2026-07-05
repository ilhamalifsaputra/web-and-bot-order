import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardRow } from "./CardRow";

describe("CardRow", () => {
  it("renders the label and value", () => {
    render(<CardRow label="Telegram ID" value="123456" />);
    expect(screen.getByText("Telegram ID")).toBeInTheDocument();
    expect(screen.getByText("123456")).toBeInTheDocument();
  });

  it("accepts a ReactNode as the value", () => {
    render(<CardRow label="Role" value={<span data-testid="role-value">Admin</span>} />);
    expect(screen.getByTestId("role-value")).toBeInTheDocument();
  });
});
