import "@testing-library/jest-dom";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import StatusBadge from "./StatusBadge";

describe("StatusBadge", () => {
  afterEach(() => {
    document.documentElement.lang = "";
  });

  it("shows the English label by default", () => {
    document.documentElement.lang = "en";
    render(<StatusBadge value="pending_payment" />);
    expect(screen.getByText("Awaiting payment")).toBeInTheDocument();
  });

  it("shows the Indonesian label when the page language is id", () => {
    document.documentElement.lang = "id";
    render(<StatusBadge value="pending_payment" />);
    expect(screen.getByText("Menunggu pembayaran")).toBeInTheDocument();
  });

  it("translates a reused status.label.* key (delivered)", () => {
    document.documentElement.lang = "id";
    render(<StatusBadge value="DELIVERED" />);
    expect(screen.getByText("Terkirim")).toBeInTheDocument();
  });

  it("translates the ticket-list 'open' status without ticket-flavoured wording", () => {
    // StatusBadge renders tickets on the /account/support list — it must NOT
    // borrow web.ticket_status_open's "Waiting for Support" copy, which is
    // reserved for TicketStatusBadge on the ticket detail page.
    document.documentElement.lang = "id";
    render(<StatusBadge value="open" />);
    expect(screen.getByText("Terbuka")).toBeInTheDocument();
    expect(screen.queryByText("Menunggu Dukungan")).not.toBeInTheDocument();
  });

  it("is case-insensitive on the value prop", () => {
    document.documentElement.lang = "en";
    render(<StatusBadge value="Available" />);
    expect(screen.getByText("In stock")).toBeInTheDocument();
  });

  it("falls back to a title-cased rendering of an unknown value", () => {
    document.documentElement.lang = "en";
    render(<StatusBadge value="some_weird_status" />);
    expect(screen.getByText("Some Weird Status")).toBeInTheDocument();
  });
});
