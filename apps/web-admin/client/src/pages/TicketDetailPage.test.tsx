import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TicketDetailPage } from "./TicketDetailPage";
import { apiPost } from "../api/client";

// apiGet forwards to the global `fetch` each test stubs, and — like the real
// client — puts the HTTP status on the error it throws.
vi.mock("../api/client", () => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(async (path: string) => {
    const res = await fetch(path);
    if (!res.ok) {
      const err = new Error(`${path} responded ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return res.json();
  }),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/support/1"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/support/:ticketId" element={children} />
          <Route path="/support" element={<div>support-list-page</div>} />
          <Route path="/orders/:orderId" element={<div>order-detail-page</div>} />
          <Route path="/users/:userId" element={<div>user-detail-page</div>} />
        </Routes>
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const ADMIN_ROW = { id: 7, telegramId: 555, name: "Rina" };

const BASE_USER = {
  id: 10,
  fullName: "Budi",
  username: null,
  telegramId: "12345",
  loginUsername: null,
  email: null,
  guestEmail: null,
  isGuest: false,
};

const BASE_TICKET = {
  id: 1,
  ticketNumber: null,
  userId: 10,
  subject: "Order tidak sampai",
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
  createdAtShort: "10:00",
  orderId: null,
  order: null,
};

function auditRow(over: Record<string, unknown>) {
  return {
    adminId: 7,
    actorType: "ADMIN",
    details: null,
    statusChange: null,
    createdAtShort: null,
    ...over,
  };
}

const BASE_DETAIL = {
  ticket: BASE_TICKET,
  messages: [
    {
      id: 1,
      content: "Halo, order saya belum sampai",
      senderType: "USER",
      senderId: 10,
      internal: false,
      createdAt: "2026-06-26T10:05:00.000Z",
      createdAtDisplay: "2026-06-26 10:05",
      createdAtShort: "10:05",
      photoFileIds: null,
    },
  ],
  user: BASE_USER,
  customer: { totalSpent: { idr: "500000", usdt: "0" }, orderCount: 3, openTicketCount: 1 },
  timeline: {
    ticket: [
      auditRow({
        id: 100,
        action: "ticket_assign",
        details: 'Assigned ticket #1 to "Rina".',
        createdAt: "2026-06-26T11:00:00.000Z",
        createdAtDisplay: "2026-06-26 11:00",
        createdAtShort: "11:00",
      }),
    ],
    order: [],
  },
};

const LINKED_ORDER = {
  id: 55,
  orderCode: "ORD-20260601-055",
  createdAt: "2026-06-01T08:00:00.000Z",
  createdAtDisplay: "2026-06-01",
  totalAmount: "100000",
  currency: "IDR",
  items: [
    { id: 1, quantity: 1, unitPrice: "50000", product: { id: 9, name: "Netflix 1 Bulan" } },
    { id: 2, quantity: 1, unitPrice: "50000", product: { id: 9, name: "Netflix 1 Bulan" } },
  ],
  voucher: { code: "DISKON10", type: "percent" },
};

const LINKED_TICKET = { ...BASE_TICKET, orderId: 55, order: LINKED_ORDER };

const ORDER_DETAIL = {
  order: {
    id: 55,
    orderCode: "ORD-20260601-055",
    items: [
      {
        id: 1,
        quantity: 1,
        unitPrice: "50000",
        product: { id: 9, name: "Netflix 1 Bulan" },
        stockItem: { id: 900, credentials: "rahasia@mail.com:pw" },
      },
      {
        id: 2,
        quantity: 1,
        unitPrice: "50000",
        product: { id: 9, name: "Netflix 1 Bulan" },
        stockItem: { id: 901, credentials: "kedua@mail.com:pw" },
      },
    ],
  },
  isDelivered: true,
  stockReplacements: [] as unknown[],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** `order` is the GET /api/orders/:orderId response (per-unit list); a number
 *  makes that call fail with that HTTP status; null rejects it outright. */
function mockFetches(
  detail: unknown,
  admins: unknown = { admins: [ADMIN_ROW] },
  order: unknown = null,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/admins")) return Promise.resolve(jsonResponse(admins));
    if (url.includes("/api/support/")) return Promise.resolve(jsonResponse(detail));
    if (url.includes("/api/orders/")) {
      if (typeof order === "number") return Promise.resolve(jsonResponse({ error: "nope" }, order));
      if (order !== null) return Promise.resolve(jsonResponse(order));
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
}

async function renderLoaded(detail: unknown = BASE_DETAIL, admins?: unknown, order?: unknown) {
  mockFetches(detail, admins, order);
  const utils = render(<TicketDetailPage />, { wrapper: Wrapper });
  await screen.findByRole("heading", { name: "Conversation" });
  return utils;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiPost).mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("TicketDetailPage — loading and failure", () => {
  it("shows section skeletons while the ticket loads, not a bare Loading… line", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    render(<TicketDetailPage />, { wrapper: Wrapper });
    expect(screen.getByRole("status", { name: "Loading ticket" })).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("keeps the explicit error when the ticket itself fails to load", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(jsonResponse({ error: "x" }, 500)));
    render(<TicketDetailPage />, { wrapper: Wrapper });
    expect(await screen.findByText("Failed to load ticket.")).toBeInTheDocument();
  });
});

describe("TicketDetailPage — header", () => {
  it("uses the subject as the description, not the customer's full complaint", async () => {
    await renderLoaded();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Ticket #1");
    expect(h1.parentElement).toHaveTextContent("Order tidak sampai");
    expect(h1.parentElement).not.toHaveTextContent("mohon bantuannya");
  });

  it("shows the ticketNumber when present", async () => {
    await renderLoaded({ ...BASE_DETAIL, ticket: { ...BASE_TICKET, ticketNumber: "TCK-20260828-00001" } });
    expect(screen.getByText("Ticket TCK-20260828-00001")).toBeInTheDocument();
  });

  it("falls back to #id for a historical ticket with no ticketNumber", async () => {
    await renderLoaded();
    expect(screen.getByText("Ticket #1")).toBeInTheDocument();
  });

  it("labels a waiting-for-customer ticket in plain words", async () => {
    await renderLoaded({ ...BASE_DETAIL, ticket: { ...BASE_TICKET, status: "WAITING_CUSTOMER" } });
    expect(screen.getByText("Waiting for customer")).toBeInTheDocument();
  });

  it("lays the page out header → conversation → order → customer → activity", async () => {
    await renderLoaded({ ...BASE_DETAIL, ticket: LINKED_TICKET }, undefined, ORDER_DETAIL);
    const sequence = [
      screen.getByText("Order tidak sampai"),
      screen.getByRole("heading", { name: "Conversation" }),
      screen.getByRole("heading", { name: "Order" }),
      screen.getByRole("heading", { name: "Customer" }),
      screen.getByText(/^Activity \(\d+\)$/),
    ];
    for (let i = 1; i < sequence.length; i++) {
      expect(sequence[i - 1].compareDocumentPosition(sequence[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe("TicketDetailPage — conversation", () => {
  it("starts with the customer's original complaint, then the thread, with short times and full-time tooltips", async () => {
    const detail = {
      ...BASE_DETAIL,
      messages: [
        ...BASE_DETAIL.messages,
        {
          id: 2,
          content: "Kami cek dulu ya.",
          senderType: "ADMIN",
          senderId: 7,
          internal: false,
          createdAt: "2026-06-26T10:10:00.000Z",
          createdAtDisplay: "2026-06-26 10:10",
          createdAtShort: "10:10",
          photoFileIds: null,
        },
        {
          id: 3,
          content: "Sudah dicek.",
          senderType: "ADMIN",
          senderId: 99,
          internal: false,
          createdAt: "2026-06-26T10:20:00.000Z",
          createdAtDisplay: "2026-06-26 10:20",
          createdAtShort: "10:20",
          photoFileIds: null,
        },
      ],
    };
    await renderLoaded(detail);
    const messages = screen.getAllByTestId("ticket-message");
    expect(messages).toHaveLength(4);
    expect(messages[0]).toHaveTextContent("Customer · 10:00");
    expect(messages[0]).toHaveTextContent("Order tidak sampai, mohon bantuannya");
    expect(within(messages[0]).getByText("10:00")).toHaveAttribute("title", "2026-06-26 10:00");
    expect(messages[1]).toHaveTextContent("Customer · 10:05");
    // The replying admin by name; an admin outside the roster falls back to "Admin".
    expect(messages[2]).toHaveTextContent("Rina · 10:10");
    expect(messages[3]).toHaveTextContent("Admin · 10:20");
  });

  it("renders an internal note in a dashed, badge-marked bubble distinct from a customer-visible message", async () => {
    const detail = {
      ...BASE_DETAIL,
      messages: [
        ...BASE_DETAIL.messages,
        {
          id: 2,
          content: "Waiting on courier confirmation before replying.",
          senderType: "ADMIN",
          senderId: 7,
          internal: true,
          createdAt: "2026-06-26T12:00:00.000Z",
          createdAtDisplay: "2026-06-26 12:00",
          createdAtShort: "12:00",
          photoFileIds: null,
        },
      ],
    };
    await renderLoaded(detail);

    expect(screen.getByText("Internal note")).toBeInTheDocument();
    const internalBubble = screen
      .getByText("Waiting on courier confirmation before replying.")
      .closest('[data-testid="ticket-message"]');
    expect(internalBubble).toHaveClass("border-dashed");
    const customerBubble = screen.getByText("Halo, order saya belum sampai").closest('[data-testid="ticket-message"]');
    expect(customerBubble).not.toHaveClass("border-dashed");
  });

  it("opens a ticket photo attachment in a preview dialog", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderLoaded({ ...BASE_DETAIL, ticket: { ...BASE_TICKET, photoFileIds: "abc123" } });

    const firstMessage = screen.getAllByTestId("ticket-message")[0];
    expect(within(firstMessage).getByAltText("Attachment")).toHaveAttribute("src", "/api/support/photo/abc123");

    await user.click(within(firstMessage).getByRole("button", { name: "View attachment" }));
    expect(await screen.findByAltText("Attachment preview")).toHaveAttribute("src", "/api/support/photo/abc123");
  });

  it("places the reply form inside the conversation, sending internal: false by default", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    await renderLoaded();

    const conversation = screen.getByRole("heading", { name: "Conversation" }).closest('[data-slot="card"]') as HTMLElement;
    await user.type(within(conversation).getByPlaceholderText(/write a reply/i), "We're checking.");
    await user.click(within(conversation).getByRole("button", { name: /^send reply$/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/support/1/reply", { content: "We're checking.", internal: false }),
    );
  });

  it("checking the internal-note toggle sends internal: true and relabels the button", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    await renderLoaded();

    await user.type(screen.getByPlaceholderText(/write a reply/i), "Checked with the courier.");
    await user.click(screen.getByRole("checkbox", { name: /internal note/i }));
    await user.click(screen.getByRole("button", { name: /save internal note/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/support/1/reply", {
        content: "Checked with the courier.",
        internal: true,
      }),
    );
  });
});

describe("TicketDetailPage — ticket controls", () => {
  it("sends a priority update via POST /api/support/:ticketId/priority", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    await renderLoaded();

    expect(screen.getByText("High")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Ticket priority" }));
    await user.click(await screen.findByRole("option", { name: "Urgent" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/priority", { priority: "URGENT" }));
  });

  it("shows Not categorized by default and sends a category update via POST /api/support/:ticketId/classify", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    await renderLoaded();

    expect(screen.getByRole("combobox", { name: "Ticket category" })).toHaveTextContent("Not categorized");
    expect(screen.queryByText("Uncategorized")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Ticket category" }));
    await user.click(await screen.findByRole("option", { name: "Payment" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/classify", { category: "PAYMENT" }));
  });

  it("shows Unassigned with no assigned-by note for a ticket with no assignee", async () => {
    await renderLoaded();
    expect(screen.getByRole("combobox", { name: "Ticket assignee" })).toHaveTextContent("Unassigned");
    expect(screen.queryByText(/assigned by/i)).not.toBeInTheDocument();
  });

  it("shows who assigned the ticket and when, once assigned", async () => {
    await renderLoaded({
      ...BASE_DETAIL,
      ticket: {
        ...BASE_TICKET,
        adminId: 7,
        assignedAt: "2026-06-26T09:00:00.000Z",
        assignedAtDisplay: "2026-06-26 09:00",
        assignedBy: 7,
      },
    });
    expect(screen.getByRole("combobox", { name: "Ticket assignee" })).toHaveTextContent("Rina");
    expect(screen.getByText("Assigned by Rina · 2026-06-26 09:00")).toBeInTheDocument();
  });

  it("reassigning via the picker posts the new adminId to POST /api/support/:ticketId/assign", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    await renderLoaded(BASE_DETAIL, { admins: [ADMIN_ROW, { id: 9, telegramId: 111, name: null }] });

    await user.click(screen.getByRole("combobox", { name: "Ticket assignee" }));
    await user.click(await screen.findByRole("option", { name: "Telegram ID 111" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/assign", { adminId: 9 }));
  });

  it("offers Resolve (not Reopen) for an OPEN ticket, and posts to /resolve", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    await renderLoaded();

    expect(screen.queryByRole("button", { name: /reopen/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /resolve/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/resolve", {}));
  });

  it("offers Reopen (not Resolve, Close, or the reply form) for a CLOSED ticket, and posts to /reopen", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    await renderLoaded({ ...BASE_DETAIL, ticket: { ...BASE_TICKET, status: "CLOSED" } });

    expect(screen.queryByRole("button", { name: /^resolve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close ticket/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send reply/i })).not.toBeInTheDocument();
    expect(screen.getByText("This ticket is closed. Reopen it to reply.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /reopen/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/reopen", {}));
  });

  it("closes a ticket only after confirming", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    await renderLoaded();

    await user.click(screen.getByRole("button", { name: /close ticket/i }));
    expect(apiPost).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/close", {}));
  });
});

describe("TicketDetailPage — order context", () => {
  it("does not render the order section when the ticket has no linked order", async () => {
    await renderLoaded();
    expect(screen.queryByRole("heading", { name: "Order" })).not.toBeInTheDocument();
    expect(screen.queryByText("Affected units")).not.toBeInTheDocument();
  });

  it("groups identical units into one line and formats money", async () => {
    await renderLoaded({ ...BASE_DETAIL, ticket: LINKED_TICKET }, undefined, ORDER_DETAIL);
    const orderCard = screen.getByRole("heading", { name: "Order" }).closest('[data-slot="card"]') as HTMLElement;

    expect(within(orderCard).getByRole("link", { name: "ORD-20260601-055" })).toHaveAttribute("href", "/orders/55");
    expect(within(orderCard).getByText("Purchased 2026-06-01")).toBeInTheDocument();
    expect(within(orderCard).getAllByText("Netflix 1 Bulan")).toHaveLength(1);
    expect(within(orderCard).getByText("2 units · Rp50.000 each")).toBeInTheDocument();
    expect(within(orderCard).getByText("Rp100.000")).toBeInTheDocument();
    expect(within(orderCard).getByText("DISKON10 (percent)")).toBeInTheDocument();
    expect(within(orderCard).queryByText("50000")).not.toBeInTheDocument();
  });

  it("shows only the latest order activity, with the rest behind View full order activity", async () => {
    const detail = {
      ...BASE_DETAIL,
      ticket: LINKED_TICKET,
      timeline: {
        ...BASE_DETAIL.timeline,
        order: [
          auditRow({ id: 201, adminId: null, action: "order_deliver", details: "Auto-delivered order.", createdAt: "2026-06-01T09:05:00.000Z", createdAtDisplay: "2026-06-01 09:05", createdAtShort: "Jun 1, 09:05" }),
          auditRow({ id: 200, action: "order_approve", details: "Approved order #55.", createdAt: "2026-06-01T09:00:00.000Z", createdAtDisplay: "2026-06-01 09:00", createdAtShort: "Jun 1, 09:00" }),
        ],
      },
    };
    await renderLoaded(detail, undefined, ORDER_DETAIL);

    expect(screen.getByText("Latest order activity")).toBeInTheDocument();
    expect(screen.getByText("Auto-delivered order.")).toBeVisible();
    const older = screen.getByText("Approved order #55.");
    expect(older.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("View full order activity")).toBeInTheDocument();
    expect(older.closest("li")).toHaveTextContent("Rina");
  });

  it("says so when the order has no activity yet", async () => {
    await renderLoaded({ ...BASE_DETAIL, ticket: LINKED_TICKET }, undefined, ORDER_DETAIL);
    expect(screen.getByText("No order activity recorded yet.")).toBeInTheDocument();
    expect(screen.queryByText("View full order activity")).not.toBeInTheDocument();
  });
});

describe("TicketDetailPage — affected units", () => {
  it("shows the units without credentials, how many this ticket reported, and creates a replacement on this ticket", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const order = {
      ...ORDER_DETAIL,
      stockReplacements: [
        {
          id: 1, orderItemId: 1, status: "COMPLETED", reason: "dead", replacementStockItemId: 950,
          supportTicketId: 1, requestedAtDisplay: "2026-06-02", resolvedAtDisplay: "2026-06-02", refund: null,
        },
        {
          id: 2, orderItemId: 2, status: "COMPLETED", reason: "other ticket", replacementStockItemId: 951,
          supportTicketId: 99, requestedAtDisplay: "2026-06-03", resolvedAtDisplay: "2026-06-03", refund: null,
        },
      ],
    };
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, status: "AWAITING_STOCK", credentialIssued: false });
    await renderLoaded({ ...BASE_DETAIL, ticket: LINKED_TICKET }, undefined, order);

    await screen.findByText("Affected units");
    expect(screen.getByText("1 of 2 units reported on this ticket")).toBeInTheDocument();
    expect(screen.queryByText("rahasia@mail.com:pw")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /report issue/i })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Create replacement" })[0]);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText(/what was wrong/i), "akun tidak bisa login");
    await user.click(within(dialog).getByRole("button", { name: "Create replacement" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/orders/55/items/1/replace", {
        reason: "akun tidak bisa login",
        supportTicketId: 1,
      }),
    );
  });

  it("offers a retry when the order details fail to load, keeping the rest of the page usable", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = await renderLoaded({ ...BASE_DETAIL, ticket: LINKED_TICKET }, undefined, 500).then(
      () => vi.mocked(globalThis.fetch),
    );

    expect(await screen.findByText("Order details couldn't be loaded.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/write a reply/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ORD-20260601-055" })).toBeInTheDocument();

    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/orders/")) return Promise.resolve(jsonResponse(ORDER_DETAIL));
      if (url.includes("/api/admins")) return Promise.resolve(jsonResponse({ admins: [ADMIN_ROW] }));
      return Promise.resolve(jsonResponse({ ...BASE_DETAIL, ticket: LINKED_TICKET }));
    });
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("0 of 2 units reported on this ticket")).toBeInTheDocument();
    expect(screen.queryByText("Order details couldn't be loaded.")).not.toBeInTheDocument();
  });

  it("stays silent for a role that may not read the order (403)", async () => {
    await renderLoaded({ ...BASE_DETAIL, ticket: LINKED_TICKET }, undefined, 403);
    await waitFor(() => expect(screen.queryByText("Affected units")).not.toBeInTheDocument());
    expect(screen.queryByText("Order details couldn't be loaded.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Order" })).toBeInTheDocument();
  });
});

describe("TicketDetailPage — customer", () => {
  function customerCard() {
    return screen.getByRole("heading", { name: "Customer" }).closest('[data-slot="card"]') as HTMLElement;
  }

  it("renders identity, orders, total spent, open tickets and the profile link", async () => {
    await renderLoaded();
    const card = customerCard();
    expect(within(card).getByText("Budi")).toBeInTheDocument();
    expect(within(card).getByText("12345")).toBeInTheDocument();
    expect(within(card).getByText("Rp500.000")).toBeInTheDocument();
    expect(within(card).getByText("3")).toBeInTheDocument();
    expect(within(card).getByText("1")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /view customer profile/i })).toHaveAttribute("href", "/users/10");
  });

  it("names a web-only customer by login username instead of Unknown", async () => {
    await renderLoaded({
      ...BASE_DETAIL,
      user: { ...BASE_USER, fullName: null, telegramId: null, loginUsername: "budi_web", email: "budi@example.com" },
    });
    const card = customerCard();
    expect(within(card).getByText("budi_web")).toBeInTheDocument();
    expect(within(card).getByText("budi@example.com")).toBeInTheDocument();
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });

  it("labels a guest checkout as a guest with their email", async () => {
    await renderLoaded({
      ...BASE_DETAIL,
      user: { ...BASE_USER, fullName: null, telegramId: null, isGuest: true, guestEmail: "guest@example.com" },
    });
    const card = customerCard();
    expect(within(card).getByText("Guest customer")).toBeInTheDocument();
    expect(within(card).getByText("guest@example.com")).toBeInTheDocument();
  });

  it("says Customer unavailable when the customer record is missing", async () => {
    await renderLoaded({ ...BASE_DETAIL, user: null });
    const card = customerCard();
    expect(within(card).getByText("Customer unavailable")).toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: /view customer profile/i })).not.toBeInTheDocument();
  });
});

describe("TicketDetailPage — activity", () => {
  it("is collapsed by default and counts its entries", async () => {
    await renderLoaded();
    const summary = screen.getByText("Activity (2)");
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });

  it("starts with Ticket created, oldest first, with the public ticket label in details", async () => {
    const detail = {
      ...BASE_DETAIL,
      ticket: { ...BASE_TICKET, ticketNumber: "TCK-20260626-00001" },
      timeline: {
        ...BASE_DETAIL.timeline,
        ticket: [
          auditRow({ id: 102, action: "ticket_set_priority", details: "Changed ticket #1 priority to High.", createdAt: "2026-06-26T11:30:00.000Z", createdAtDisplay: "2026-06-26 11:30", createdAtShort: "11:30" }),
          ...BASE_DETAIL.timeline.ticket,
        ],
      },
    };
    await renderLoaded(detail);

    const rows = screen.getAllByTestId("activity-entry");
    expect(rows.map((r) => r.textContent)).toEqual([
      "10:00 · Ticket created",
      '11:00 · Assigned ticket TCK-20260626-00001 to "Rina".',
      "11:30 · Changed ticket TCK-20260626-00001 priority to High.",
    ]);
    expect(within(rows[0]).getByText("10:00")).toHaveAttribute("title", "2026-06-26 10:00");
  });

  it("merges a reply with the status change it caused", async () => {
    const detail = {
      ...BASE_DETAIL,
      timeline: {
        ...BASE_DETAIL.timeline,
        ticket: [
          auditRow({ id: 111, action: "ticket_status_change", details: "Ticket #1 moved from OPEN to WAITING_CUSTOMER.", statusChange: { from: "OPEN", to: "WAITING_CUSTOMER" }, createdAt: "2026-06-26T12:00:01.000Z", createdAtDisplay: "2026-06-26 12:00", createdAtShort: "12:00" }),
          auditRow({ id: 110, action: "ticket_reply", details: "Replied to ticket #1.", createdAt: "2026-06-26T12:00:00.000Z", createdAtDisplay: "2026-06-26 12:00", createdAtShort: "12:00" }),
        ],
      },
    };
    await renderLoaded(detail);

    const rows = screen.getAllByTestId("activity-entry");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent("12:00 · Rina replied");
    expect(rows[1]).toHaveTextContent("Status → Waiting for customer");
    expect(screen.queryByText(/moved from OPEN/)).not.toBeInTheDocument();
  });

  it("labels a customer's own action as Customer, not System", async () => {
    const detail = {
      ...BASE_DETAIL,
      timeline: {
        ...BASE_DETAIL.timeline,
        ticket: [
          auditRow({ id: 120, adminId: null, actorType: "CUSTOMER", action: "ticket_reply", details: "Customer replied via Telegram.", createdAt: "2026-06-26T12:00:00.000Z", createdAtDisplay: "2026-06-26 12:00", createdAtShort: "12:00" }),
          auditRow({ id: 119, adminId: null, actorType: "CUSTOMER", action: "ticket_create", details: "Created a support ticket via Telegram.", createdAt: "2026-06-26T10:00:00.000Z", createdAtDisplay: "2026-06-26 10:00", createdAtShort: "10:00" }),
        ],
      },
    };
    await renderLoaded(detail);

    const rows = screen.getAllByTestId("activity-entry");
    // The real ticket_create row replaces the synthetic one — no duplicate.
    expect(rows.map((r) => r.textContent)).toEqual(["10:00 · Ticket created", "12:00 · Customer replied"]);
    expect(screen.queryByText(/System/)).not.toBeInTheDocument();
  });

  it("says No additional activity yet when nothing happened after creation", async () => {
    await renderLoaded({ ...BASE_DETAIL, timeline: { ticket: [], order: [] } });
    expect(screen.getByText("Activity (1)")).toBeInTheDocument();
    expect(screen.getByText("No additional activity yet.")).toBeInTheDocument();
  });
});
