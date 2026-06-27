import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuickActionsBar } from "./QuickActionsBar";

describe("QuickActionsBar", () => {
  it("renders each quick action as a link to an existing admin page", () => {
    render(<QuickActionsBar />);
    expect(screen.getByText("Add Product").closest("a")).toHaveAttribute("href", "/catalog");
    expect(screen.getByText("Add Stock").closest("a")).toHaveAttribute("href", "/stock");
    expect(screen.getByText("Broadcast").closest("a")).toHaveAttribute("href", "/broadcast");
    expect(screen.getByText("Add Customer").closest("a")).toHaveAttribute("href", "/users");
    expect(screen.getByText("Reports").closest("a")).toHaveAttribute("href", "/reports");
    expect(screen.getByText("Orders").closest("a")).toHaveAttribute("href", "/orders");
  });
});
