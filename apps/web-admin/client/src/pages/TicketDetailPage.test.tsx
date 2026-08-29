import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TicketDetailPage } from "./TicketDetailPage";
import { apiPost } from "../api/client";

vi.mock("../api/client", () => ({
  apiPost: vi.fn(),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/support/1"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/support/:ticketId" element={children} />
          <Route path="/orders/:orderId" element={<div>order-detail-page</div>} />
          <Route path="/users/:userId" element={<div>user-detail-page</div>} />
        </Routes>
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const ADMIN_ROW = { id: 7, telegramId: 555, name: "Rina" };

const BASE_TICKET = {
  id: 1,
  ticketNumber: null,
  userId: 10,
  message: "Order tidak sampai, mohon bantuannya",
  photoFileIds: null,
  status: "OPEN",
  priority: "HIGH",
  category: null,
  adminId: null,
  assignedAt: null,
  assignedAtDisplay: null,
  assignedBy: null,
  createdAt: "2026-06-26T10:00:00.000Z",
  createdAtDisplay: "2026-06-26 10:00",
  orderId: null,
  order: null,
};

const BASE_DETAIL = {
  ticket: BASE_TICKET,
  messages: [
    { id: 1, content: "Halo, order saya belum sampai", senderType: "USER", internal: false, createdAt: "2026-06-26T10:00:00.000Z", createdAtDisplay: "2026-06-26 10:00", photoFileIds: null },
  ],
  user: { id: 10, fullName: "Budi", username: null },
  customer: { totalSpent: { idr: "500000", usdt: "0" }, orderCount: 3, openTicketCount: 1 },
  timeline: {
    ticket: [
      {
        id: 100,
        adminId: 7,
        action: "ticket_reply",
        details: 'Replied to ticket #1.',
        createdAt: "2026-06-26T11:00:00.000Z",
        createdAtDisplay: "2026-06-26 11:00",
      },
    ],
    order: [],
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetches(detail: unknown, admins: unknown = { admins: [ADMIN_ROW] }) {
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/admins")) return Promise.resolve(jsonResponse(admins));
    if (url.includes("/api/support/")) return Promise.resolve(jsonResponse(detail));
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiPost).mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("TicketDetailPage — order context panel", () => {
  it("does not render the Order Context card when the ticket has no linked order", async () => {
    mockFetches(BASE_DETAIL);
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());
    expect(screen.queryByText("Order Context")).not.toBeInTheDocument();
  });

  it("renders order items, voucher, and order activity when the ticket has a linked order", async () => {
    const detail = {
      ...BASE_DETAIL,
      ticket: {
        ...BASE_TICKET,
        orderId: 55,
        order: {
          id: 55,
          orderCode: "ORD-055",
          createdAt: "2026-06-01T08:00:00.000Z",
          createdAtDisplay: "2026-06-01",
          items: [{ id: 1, quantity: 2, unitPrice: "50000", product: { id: 9, name: "Netflix 1 Bulan" } }],
          voucher: { code: "DISKON10", type: "percent" },
        },
      },
      timeline: {
        ...BASE_DETAIL.timeline,
        order: [
          {
            id: 200,
            adminId: 7,
            action: "order_approve",
            details: "Approved order #55.",
            createdAt: "2026-06-01T09:00:00.000Z",
            createdAtDisplay: "2026-06-01 09:00",
          },
        ],
      },
    };
    mockFetches(detail);
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order Context")).toBeInTheDocument());

    expect(screen.getByText("ORD-055")).toBeInTheDocument();
    expect(screen.getByText("Netflix 1 Bulan × 2")).toBeInTheDocument();
    expect(screen.getByText("DISKON10 (percent)")).toBeInTheDocument();
    expect(screen.getByText("Order Activity")).toBeInTheDocument();
    expect(screen.getByText("Approved order #55.")).toBeInTheDocument();
    expect(screen.getAllByText(/Rina/).length).toBeGreaterThan(0);
  });
});

describe("TicketDetailPage — customer context panel", () => {
  it("renders total spent, total orders, and open ticket count with a link to the customer profile", async () => {
    mockFetches(BASE_DETAIL);
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());

    expect(screen.getByText("Rp500.000")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view customer profile/i })).toHaveAttribute("href", "/users/10");
  });
});

describe("TicketDetailPage — ticket timeline", () => {
  it("renders a synthetic Created row before the audit-log rows, oldest first", async () => {
    // Two audit-log rows, deliberately supplied newest-first (as the real
    // /api/support/:ticketId route returns them, per listAuditLogs' `orderBy:
    // { createdAt: "desc" }`) — this is the only way to actually exercise
    // TicketDetailPage.tsx's `[...timeline.ticket].reverse()` chronological
    // ordering; a single-row fixture can't tell a correct reverse from a
    // no-op or a double-reverse.
    const detail = {
      ...BASE_DETAIL,
      timeline: {
        ...BASE_DETAIL.timeline,
        ticket: [
          {
            id: 101,
            adminId: 7,
            action: "ticket_reply",
            details: "Replied to ticket #1.",
            createdAt: "2026-06-26T11:00:00.000Z",
            createdAtDisplay: "2026-06-26 11:00",
          },
          {
            id: 100,
            adminId: 7,
            action: "ticket_assign",
            details: 'Assigned ticket #1 to "Rina".',
            createdAt: "2026-06-26T10:30:00.000Z",
            createdAtDisplay: "2026-06-26 10:30",
          },
        ],
      },
    };
    mockFetches(detail);
    const { container } = render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Created")).toBeInTheDocument());

    const rows = within(container).getAllByTestId("timeline-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Created"),
      expect.stringContaining('Assigned ticket #1 to "Rina".'),
      expect.stringContaining("Replied to ticket #1."),
    ]);
  });
});

describe("TicketDetailPage — attachments", () => {
  it("renders a thumbnail for a ticket photo attachment and opens a dialog with the full image on click", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const detail = { ...BASE_DETAIL, ticket: { ...BASE_TICKET, photoFileIds: "abc123" } };
    mockFetches(detail);
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());

    const thumbnails = screen.getAllByAltText("Attachment");
    expect(thumbnails.length).toBeGreaterThan(0);
    expect(thumbnails[0]).toHaveAttribute("src", "/api/support/photo/abc123");

    await user.click(screen.getByRole("button", { name: "View attachment" }));
    expect(await screen.findByAltText("Attachment preview")).toHaveAttribute("src", "/api/support/photo/abc123");
  });
});

describe("TicketDetailPage — priority control", () => {
  it("shows the current priority badge and sends a priority update via POST /api/support/:ticketId/priority", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetches(BASE_DETAIL);
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());

    expect(screen.getByText("High")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Ticket priority" }));
    await waitFor(() => screen.getByRole("option", { name: "Urgent" }));
    await user.click(screen.getByRole("option", { name: "Urgent" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/support/1/priority", { priority: "URGENT" }),
    );
  });
});

describe("TicketDetailPage — category control", () => {
  it("shows Uncategorized by default and sends a category update via POST /api/support/:ticketId/classify", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetches(BASE_DETAIL);
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());

    expect(screen.getByText("Uncategorized")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Ticket category" }));
    await waitFor(() => screen.getByRole("option", { name: "Payment" }));
    await user.click(screen.getByRole("option", { name: "Payment" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/support/1/classify", { category: "PAYMENT" }),
    );
  });
});

describe("TicketDetailPage — resolve/reopen", () => {
  it("offers Resolve (not Reopen) for an OPEN ticket, and posts to /api/support/:ticketId/resolve", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetches(BASE_DETAIL);
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /reopen/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /resolve/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/resolve", {}));
  });

  it("offers Reopen (not Resolve, not the reply form) for a CLOSED ticket, and posts to /api/support/:ticketId/reopen", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const detail = { ...BASE_DETAIL, ticket: { ...BASE_TICKET, status: "CLOSED" } };
    mockFetches(detail);
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /^resolve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send reply/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /reopen/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/reopen", {}));
  });
});

describe("TicketDetailPage — ticket number display (Task 3)", () => {
  it("shows the ticketNumber prominently when present", async () => {
    const detail = { ...BASE_DETAIL, ticket: { ...BASE_TICKET, ticketNumber: "TCK-20260828-00001" } };
    mockFetches(detail);
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket TCK-20260828-00001")).toBeInTheDocument());
  });

  it("falls back to #id for a historical ticket with no ticketNumber", async () => {
    mockFetches(BASE_DETAIL); // BASE_TICKET.ticketNumber is null
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1")).toBeInTheDocument());
  });
});

describe("TicketDetailPage — internal note toggle (Task 3)", () => {
  it("checking the toggle sends internal: true and switches the button to Save Internal Note", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetches(BASE_DETAIL);
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/write a reply/i), "Checked with the courier.");
    await user.click(screen.getByRole("checkbox", { name: /internal note/i }));
    expect(screen.getByRole("button", { name: /save internal note/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save internal note/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/support/1/reply", {
        content: "Checked with the courier.",
        internal: true,
      }),
    );
  });

  it("leaves the toggle unchecked by default, sending internal: false for an ordinary reply", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetches(BASE_DETAIL);
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/write a reply/i), "We're checking.");
    await user.click(screen.getByRole("button", { name: /^send reply$/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/support/1/reply", {
        content: "We're checking.",
        internal: false,
      }),
    );
  });

  it("renders an internal-note message in a dashed, badge-marked bubble distinct from a customer-visible message", async () => {
    const detail = {
      ...BASE_DETAIL,
      messages: [
        ...BASE_DETAIL.messages,
        {
          id: 2,
          content: "Waiting on courier confirmation before replying.",
          senderType: "ADMIN",
          internal: true,
          createdAt: "2026-06-26T12:00:00.000Z",
          createdAtDisplay: "2026-06-26 12:00",
          photoFileIds: null,
        },
      ],
    };
    mockFetches(detail);
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText("Waiting on courier confirmation before replying.")).toBeInTheDocument(),
    );

    expect(screen.getByText("Internal note")).toBeInTheDocument();
    const internalBubble = screen
      .getByText("Waiting on courier confirmation before replying.")
      .closest('[data-testid="ticket-message"]');
    expect(internalBubble).toHaveClass("border-dashed");

    // The ordinary customer message must NOT be tagged as an internal note.
    const customerBubble = screen.getByText("Halo, order saya belum sampai").closest('[data-testid="ticket-message"]');
    expect(customerBubble).not.toHaveClass("border-dashed");
  });
});

describe("TicketDetailPage — assignment picker (Task 3)", () => {
  it("shows Unassigned and 'Not yet assigned' for a ticket with no assignee", async () => {
    mockFetches(BASE_DETAIL, { admins: [ADMIN_ROW] });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());

    const trigger = screen.getByRole("combobox", { name: "Ticket assignee" });
    expect(trigger).toHaveTextContent("Unassigned");
    expect(screen.getByText("Not yet assigned.")).toBeInTheDocument();
  });

  it("surfaces assignedAt/assignedBy alongside the current adminId indicator", async () => {
    const detail = {
      ...BASE_DETAIL,
      ticket: {
        ...BASE_TICKET,
        adminId: 7,
        assignedAt: "2026-06-26T09:00:00.000Z",
        assignedAtDisplay: "2026-06-26 09:00",
        assignedBy: 7,
      },
    };
    mockFetches(detail, { admins: [ADMIN_ROW] });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());

    const trigger = screen.getByRole("combobox", { name: "Ticket assignee" });
    expect(trigger).toHaveTextContent("Rina");
    expect(screen.getByText("Assigned by Rina on 2026-06-26 09:00")).toBeInTheDocument();
  });

  it("reassigning via the picker posts the new adminId to POST /api/support/:ticketId/assign", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetches(BASE_DETAIL, { admins: [ADMIN_ROW, { id: 9, telegramId: 111, name: null }] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());

    await user.click(screen.getByRole("combobox", { name: "Ticket assignee" }));
    await user.click(await screen.findByRole("option", { name: "Telegram ID 111" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/assign", { adminId: 9 }));
  });
});
