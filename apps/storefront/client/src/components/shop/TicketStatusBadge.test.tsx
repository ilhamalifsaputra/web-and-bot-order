import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import TicketStatusBadge from "./TicketStatusBadge";

describe("TicketStatusBadge", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("shows the friendly label for OPEN", () => {
    render(<TicketStatusBadge value="OPEN" />);
    expect(screen.getByText("Waiting for Support")).toBeInTheDocument();
  });

  it("shows the friendly label for REPLIED (case-insensitive input)", () => {
    render(<TicketStatusBadge value="replied" />);
    expect(screen.getByText("Waiting for Your Reply")).toBeInTheDocument();
  });

  it("shows the friendly label for CLOSED", () => {
    render(<TicketStatusBadge value="CLOSED" />);
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("falls back to the raw value for an unknown status", () => {
    render(<TicketStatusBadge value="WEIRD" />);
    expect(screen.getByText("WEIRD")).toBeInTheDocument();
  });
});
