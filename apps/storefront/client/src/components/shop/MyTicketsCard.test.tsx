import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MyTicketsCard, { type MyTicketsCardProps } from "./MyTicketsCard";
import type { SupportTicketSummary, SupportTicketStats } from "../../api/types";
import { t } from "../../lib/i18n";

const stats: SupportTicketStats = {
  all: 2,
  waiting_for_you: 1,
  waiting_for_support: 1,
  in_progress: 0,
  resolved: 0,
  closed: 0,
};

const tickets: SupportTicketSummary[] = [
  {
    id: 10291,
    message: "Cannot log in",
    status: "waiting_customer",
    created_at_display: "2025-09-03 10:24",
    admin_reply: null,
    attachments: [],
    subject: "Alight Motion login issue",
    order_code: "ORD-10421",
    product_name: "Alight Motion",
    updated_at_iso: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 10292,
    message: "Payment stuck",
    status: "waiting_admin",
    created_at_display: "2025-09-02 08:00",
    admin_reply: null,
    subject: "Payment not confirmed",
    attachments: [],
    order_code: null,
    product_name: null,
    updated_at_iso: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
  },
];

function makeProps(over: Partial<MyTicketsCardProps> = {}): MyTicketsCardProps {
  return {
    tickets,
    stats,
    total: 2,
    page: 1,
    pageSize: 10,
    statusFilter: "all",
    sort: "latest_update",
    search: "",
    isLoading: false,
    selectedTicketId: null,
    onStatusFilterChange: vi.fn(),
    onSortChange: vi.fn(),
    onSearchChange: vi.fn(),
    onPageChange: vi.fn(),
    onSelectTicket: vi.fn(),
    ...over,
  };
}

describe("MyTicketsCard", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("renders the title, search box, sort select and the six status pills", () => {
    render(<MyTicketsCard {...makeProps()} />);
    expect(screen.getByRole("heading", { name: t("web.help_my_tickets") })).toBeInTheDocument();
    expect(screen.getByLabelText(t("web.help_search_tickets"))).toBeInTheDocument();
    expect(screen.getByLabelText(t("web.sort_label"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All (2)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Closed (0)" })).toBeInTheDocument();
  });

  it("shows the empty state when there are no tickets", () => {
    render(<MyTicketsCard {...makeProps({ tickets: [], total: 0 })} />);
    expect(screen.getByText(t("web.no_tickets"))).toBeInTheDocument();
    expect(screen.getByText(t("web.no_tickets_desc"))).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows a busy skeleton while loading and no rows", () => {
    render(<MyTicketsCard {...makeProps({ isLoading: true })} />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(t("web.no_tickets"))).toBeNull();
  });

  it("calls onSearchChange as the buyer types", async () => {
    const onSearchChange = vi.fn();
    render(<MyTicketsCard {...makeProps({ onSearchChange })} />);
    await userEvent.type(screen.getByLabelText(t("web.help_search_tickets")), "a");
    expect(onSearchChange).toHaveBeenCalledWith("a");
  });

  it("calls onSortChange when the sort select changes", async () => {
    const onSortChange = vi.fn();
    render(<MyTicketsCard {...makeProps({ onSortChange })} />);
    await userEvent.selectOptions(screen.getByLabelText(t("web.sort_label")), "created_desc");
    expect(onSortChange).toHaveBeenCalledWith("created_desc");
  });

  it("calls onStatusFilterChange when a pill is clicked", async () => {
    const onStatusFilterChange = vi.fn();
    render(<MyTicketsCard {...makeProps({ onStatusFilterChange })} />);
    await userEvent.click(screen.getByRole("button", { name: "Waiting for you (1)" }));
    expect(onStatusFilterChange).toHaveBeenCalledWith("waiting_for_you");
  });

  it("renders the mobile card list (no matchMedia -> mobile arm)", () => {
    render(<MyTicketsCard {...makeProps()} />);
    expect(screen.queryByRole("table")).toBeNull();
    const cards = screen.getAllByRole("button", { name: /Ticket #TK-/ });
    expect(cards).toHaveLength(2);
  });

  describe("desktop arm", () => {
    beforeEach(() => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }));
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("renders the ticket table with column headers", () => {
      render(<MyTicketsCard {...makeProps()} />);
      expect(screen.getByRole("table")).toBeInTheDocument();
      expect(screen.getByText(t("web.help_col_ticket"))).toBeInTheDocument();
      expect(screen.getByText(t("web.help_col_subject"))).toBeInTheDocument();
      expect(screen.getByText(t("web.help_col_last_update"))).toBeInTheDocument();
      expect(screen.getByText(t("web.help_col_date"))).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /Ticket #TK-/ })).toHaveLength(2);
    });

    it("calls onSelectTicket when a table row is activated", async () => {
      const onSelectTicket = vi.fn();
      render(<MyTicketsCard {...makeProps({ onSelectTicket })} />);
      await userEvent.click(screen.getByRole("button", { name: "Ticket #TK-10291" }));
      expect(onSelectTicket).toHaveBeenCalledWith(10291);
    });
  });
});
