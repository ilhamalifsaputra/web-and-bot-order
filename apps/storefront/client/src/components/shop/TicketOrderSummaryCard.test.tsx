import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TicketOrderSummaryCard from "./TicketOrderSummaryCard";
import type { TicketOrderSummary } from "../../api/types";

const order: TicketOrderSummary = {
  code: "ORD-TICK-1",
  status: "delivered",
  created_at_display: "2026-07-01 10:00",
  paid_at_display: "2026-07-01 10:01",
  payment_method: "BINANCE_PAY",
  total: "158000",
  voucher_code: "SAVE10",
  delivered: true,
  items: [
    { name: "Netflix", duration: "1 month", warranty_days: 30, warranty_expires_at_display: "2026-08-01 10:00", warranty_active: true },
  ],
};

describe("TicketOrderSummaryCard", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  });

  it("renders the order code, item, and total", () => {
    render(<TicketOrderSummaryCard order={order} />, { wrapper: MemoryRouter });
    expect(screen.getByText("ORD-TICK-1")).toBeInTheDocument();
    expect(screen.getByText(/Netflix/)).toBeInTheDocument();
    expect(screen.getByText("Rp158.000")).toBeInTheDocument();
  });

  it("shows the active-warranty state with its expiry date", () => {
    render(<TicketOrderSummaryCard order={order} />, { wrapper: MemoryRouter });
    expect(screen.getByText("Warranty until 2026-08-01 10:00")).toBeInTheDocument();
  });

  it("shows warranty-expired when warranty_active is false", () => {
    render(
      <TicketOrderSummaryCard order={{ ...order, items: [{ ...order.items[0]!, warranty_active: false }] }} />,
      { wrapper: MemoryRouter },
    );
    expect(screen.getByText("Warranty expired")).toBeInTheDocument();
  });

  it("shows awaiting-delivery instead of warranty-expired when the order isn't delivered yet", () => {
    render(
      <TicketOrderSummaryCard
        order={{ ...order, delivered: false, items: [{ ...order.items[0]!, warranty_active: false }] }}
      />,
      { wrapper: MemoryRouter },
    );
    expect(screen.getByText("Awaiting delivery")).toBeInTheDocument();
    expect(screen.queryByText("Warranty expired")).not.toBeInTheDocument();
  });

  it("shows a Download Credentials link (hash anchor) when delivered", () => {
    render(<TicketOrderSummaryCard order={order} />, { wrapper: MemoryRouter });
    const link = screen.getByRole("link", { name: /Download credentials/i });
    expect(link).toHaveAttribute("href", "/account/orders/ORD-TICK-1#credentials");
  });

  it("shows a plain View Order link when not delivered", () => {
    render(<TicketOrderSummaryCard order={{ ...order, delivered: false }} />, { wrapper: MemoryRouter });
    const link = screen.getByRole("link", { name: /View order/i });
    expect(link).toHaveAttribute("href", "/account/orders/ORD-TICK-1");
  });

  it("copies the order code to the clipboard", () => {
    render(<TicketOrderSummaryCard order={order} />, { wrapper: MemoryRouter });
    fireEvent.click(screen.getByRole("button", { name: /Copy order number/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ORD-TICK-1");
  });

  it("omits the voucher row when voucher_code is null", () => {
    render(<TicketOrderSummaryCard order={{ ...order, voucher_code: null }} />, { wrapper: MemoryRouter });
    expect(screen.queryByText("Voucher used")).not.toBeInTheDocument();
  });
});
