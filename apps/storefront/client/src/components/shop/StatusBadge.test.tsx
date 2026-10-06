import "@testing-library/jest-dom";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import StatusBadge from "./StatusBadge";

describe("StatusBadge", () => {
  it("preserves the wallet-credit outcome with canonical fulfillment present", () => {
    document.documentElement.lang = "en";
    render(<StatusBadge value="CREDITED_TO_BALANCE" fulfillment={{ mode: "AUTO", provider: "DIGIFLAZZ", status: "CANCELLED", payment_status: "PAID", can_edit_customer_data: false }} />);
    expect(screen.getByText("Added to credit balance")).toBeInTheDocument();
  });
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

  // Whole-branch review fix: before this, a ticket that had already gone
  // through Task 1's automatic WAITING_ADMIN/WAITING_CUSTOMER transition
  // (i.e. most real tickets by the time a buyer checks their support list)
  // fell through to the raw-value fallback below, showing "Waiting Admin" in
  // untranslated English and dropping out of the AMBER tone into neutral.
  it("buckets waiting_admin under the open label and AMBER tone", () => {
    document.documentElement.lang = "en";
    const { container } = render(<StatusBadge value="waiting_admin" />);
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(container.querySelector(".chip")).toHaveClass("bg-amberx-tint", "text-amberx");
  });

  it("buckets waiting_customer under the replied label and AMBER tone", () => {
    document.documentElement.lang = "en";
    const { container } = render(<StatusBadge value="WAITING_CUSTOMER" />);
    expect(screen.getByText("Replied")).toBeInTheDocument();
    expect(container.querySelector(".chip")).toHaveClass("bg-amberx-tint", "text-amberx");
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
