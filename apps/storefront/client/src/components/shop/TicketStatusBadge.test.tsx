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

  // Whole-branch review fix: before this, a ticket that had already gone
  // through Task 1's automatic WAITING_ADMIN/WAITING_CUSTOMER transition
  // (i.e. most real tickets) fell through to the raw-value fallback below,
  // showing a buyer the literal string "WAITING_ADMIN".
  it("buckets WAITING_ADMIN under the OPEN label (Task 1's automatic transition)", () => {
    render(<TicketStatusBadge value="WAITING_ADMIN" />);
    expect(screen.getByText("Waiting for Support")).toBeInTheDocument();
  });

  it("buckets WAITING_CUSTOMER under the REPLIED label (Task 1's automatic transition)", () => {
    render(<TicketStatusBadge value="waiting_customer" />);
    expect(screen.getByText("Waiting for Your Reply")).toBeInTheDocument();
  });

  it("falls back to the raw value for an unknown status", () => {
    render(<TicketStatusBadge value="WEIRD" />);
    expect(screen.getByText("WEIRD")).toBeInTheDocument();
  });
});
