import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsHealthCard } from "./SettingsHealthCard";

describe("SettingsHealthCard", () => {
  it("computes the percentage of CONFIGURED sections and renders a badge per section", () => {
    render(
      <SettingsHealthCard
        sections={[
          { label: "Shop Information", status: "CONFIGURED" },
          { label: "Telegram Bot", status: "CONFIGURED" },
          { label: "Payment Gateway", status: "NOT_CONFIGURED" },
          { label: "Exchange Rates", status: "CONFIGURED" },
          { label: "Security", status: "OPTIONAL" },
        ]}
      />,
    );
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText("Shop Information")).toBeInTheDocument();
    expect(screen.getByText("Not Configured")).toBeInTheDocument();
    expect(screen.getByText("Optional")).toBeInTheDocument();
  });

  it("shows 0% for an empty section list without dividing by zero", () => {
    render(<SettingsHealthCard sections={[]} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });
});
