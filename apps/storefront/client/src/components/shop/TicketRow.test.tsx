import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TicketTableRow, TicketCard, subjectOf } from "./TicketRow";
import type { SupportTicketSummary } from "../../api/types";

const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

function makeTicket(over: Partial<SupportTicketSummary> = {}): SupportTicketSummary {
  return {
    id: 10291,
    message: "First line of the message\nsecond line",
    status: "waiting_customer",
    created_at_display: "2025-09-03 10:24",
    admin_reply: null,
    attachments: [],
    subject: "Alight Motion login issue",
    order_code: "ORD-10421",
    product_name: "Alight Motion",
    updated_at_iso: twoHoursAgo,
    ...over,
  };
}

function renderRow(ui: React.ReactElement) {
  return render(
    <table>
      <tbody>{ui}</tbody>
    </table>,
  );
}

describe("subjectOf", () => {
  it("uses the trimmed subject when present", () => {
    expect(subjectOf(makeTicket({ subject: "  Hello there  " }))).toBe("Hello there");
  });

  it("falls back to the first line of the message when subject is null", () => {
    expect(subjectOf(makeTicket({ subject: null }))).toBe("First line of the message");
  });

  it("falls back when the subject is blank", () => {
    expect(subjectOf(makeTicket({ subject: "   " }))).toBe("First line of the message");
  });

  it("truncates a very long first line", () => {
    const long = "x".repeat(200);
    const out = subjectOf(makeTicket({ subject: null, message: long }));
    expect(out.length).toBeLessThan(200);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("TicketTableRow", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("renders the ticket id, subject, order code, status, relative last update and date", () => {
    renderRow(<TicketTableRow ticket={makeTicket()} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Ticket #TK-10291" })).toHaveTextContent("#TK-10291");
    expect(screen.getByText("Alight Motion login issue")).toBeInTheDocument();
    expect(screen.getByText("Order #ORD-10421")).toBeInTheDocument();
    expect(screen.getByText("Waiting for You")).toBeInTheDocument();
    expect(screen.getByText("2 hours ago")).toBeInTheDocument();
    expect(screen.getByText("2025-09-03 10:24")).toBeInTheDocument();
  });

  it("omits the order line when order_code is null", () => {
    renderRow(<TicketTableRow ticket={makeTicket({ order_code: null })} onSelect={vi.fn()} />);
    expect(screen.queryByText(/^Order #/)).toBeNull();
  });

  it("shows the message first line when subject is null", () => {
    renderRow(<TicketTableRow ticket={makeTicket({ subject: null })} onSelect={vi.fn()} />);
    expect(screen.getByText("First line of the message")).toBeInTheDocument();
  });

  it("calls onSelect when the row is clicked", async () => {
    const onSelect = vi.fn();
    renderRow(<TicketTableRow ticket={makeTicket()} onSelect={onSelect} />);
    await userEvent.click(screen.getByText("Alight Motion login issue"));
    expect(onSelect).toHaveBeenCalledWith(10291);
  });

  it("calls onSelect when the #TK button is clicked", async () => {
    const onSelect = vi.fn();
    renderRow(<TicketTableRow ticket={makeTicket()} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Ticket #TK-10291" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(10291);
  });

  it("marks the row aria-current when selected", () => {
    renderRow(<TicketTableRow ticket={makeTicket()} onSelect={vi.fn()} selected />);
    expect(screen.getByRole("row")).toHaveAttribute("aria-current", "true");
  });
});

describe("TicketCard", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("renders the id, subject, order code, status and 'relative • date' line", () => {
    render(<TicketCard ticket={makeTicket()} onSelect={vi.fn()} />);
    const card = screen.getByRole("button", { name: /Ticket #TK-10291/ });
    expect(within(card).getByText("#TK-10291")).toBeInTheDocument();
    expect(within(card).getByText("Alight Motion login issue")).toBeInTheDocument();
    expect(within(card).getByText("Order #ORD-10421")).toBeInTheDocument();
    expect(within(card).getByText("Waiting for You")).toBeInTheDocument();
    expect(within(card).getByText(/2 hours ago/)).toBeInTheDocument();
    expect(within(card).getByText(/2025-09-03 10:24/)).toBeInTheDocument();
  });

  it("calls onSelect when the card is clicked", async () => {
    const onSelect = vi.fn();
    render(<TicketCard ticket={makeTicket()} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /Ticket #TK-10291/ }));
    expect(onSelect).toHaveBeenCalledWith(10291);
  });

  it("omits the order line when order_code is null and marks aria-current when selected", () => {
    render(<TicketCard ticket={makeTicket({ order_code: null })} onSelect={vi.fn()} selected />);
    expect(screen.queryByText(/^Order #/)).toBeNull();
    expect(screen.getByRole("button", { name: /Ticket #TK-10291/ })).toHaveAttribute("aria-current", "true");
  });
});
