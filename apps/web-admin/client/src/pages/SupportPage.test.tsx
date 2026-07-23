import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { SupportPage } from "./SupportPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

/** Exposes the router's current path + query string so tests can assert on a
 *  `navigate(...)` target without a matching `<Routes>` tree (mirrors
 *  Sidebar.test.tsx / TopBar.test.tsx's LocationDisplay). */
function LocationDisplay() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

function WrapperWithLocation({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        {children}
        <LocationDisplay />
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const TICKET_OPEN = {
  id: 1,
  userId: 10,
  subject: "Order tidak sampai",
  status: "OPEN",
  priority: "MEDIUM",
  category: "ORDER",
  adminId: null,
  createdAtDisplay: "2026-06-26",
  waitingSince: "2026-06-26 10:00",
  isOverdue: false,
  user: { id: 10, fullName: "Budi", username: null, telegramId: "555" },
  admin: null,
};

const TICKET_REPLIED_ASSIGNED = {
  id: 2,
  userId: 11,
  subject: "Refund request",
  status: "REPLIED",
  priority: "HIGH",
  category: "PAYMENT",
  adminId: 7,
  createdAtDisplay: "2026-06-20",
  waitingSince: "2026-06-20 09:00",
  isOverdue: true,
  user: { id: 11, fullName: "Sari", username: null, telegramId: "777" },
  admin: { id: 7, fullName: "Rina", username: null },
};

const TICKET_CLOSED = {
  id: 3,
  userId: 12,
  subject: "Question about product",
  status: "CLOSED",
  priority: "LOW",
  category: null,
  adminId: null,
  createdAtDisplay: "2026-06-18",
  waitingSince: null,
  isOverdue: false,
  user: { id: 12, fullName: null, username: "citra", telegramId: "888" },
  admin: null,
};

// Web-only customer: signed up via the storefront, never touched the bot —
// no username, no telegramId. Regression fixture for the "Order History"
// row action, which used to fall back to the literal string "null" here.
const TICKET_WEB_ONLY_CUSTOMER = {
  id: 4,
  userId: 20,
  subject: "Payment not reflecting",
  status: "OPEN",
  priority: "MEDIUM",
  category: "PAYMENT",
  adminId: null,
  createdAtDisplay: "2026-06-27",
  waitingSince: "2026-06-27 08:00",
  isOverdue: false,
  user: { id: 20, fullName: "Web Buyer", username: null, telegramId: null, loginUsername: null },
  admin: null,
};

const TICKETS_DATA = {
  tickets: [TICKET_OPEN, TICKET_REPLIED_ASSIGNED, TICKET_CLOSED],
  total: 3,
  page: 1,
  pageSize: 20,
  hasNext: false,
  statuses: ["OPEN", "REPLIED", "RESOLVED", "CLOSED"],
  priorities: ["LOW", "MEDIUM", "HIGH", "URGENT"],
  categories: ["ORDER", "PAYMENT", "ACCOUNT", "PRODUCT", "OTHER"],
};

const KPIS_DATA = { open: 5, waitingCustomer: 2, resolved: 10, unassigned: 3, closedToday: 1, overdue: 1 };

const ADMINS_DATA = {
  admins: [
    { id: 7, telegramId: 555, role: "ADMIN", passwordSet: true, twoFa: false, hasSession: true, name: "Rina", isSelf: false, fromEnv: false },
    { id: 9, telegramId: 111, role: "ADMIN", passwordSet: true, twoFa: false, hasSession: true, name: null, isSelf: false, fromEnv: false },
  ],
  roles: ["ADMIN", "SUPER"],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Routes fetch by URL/method against small per-test overrides (mirrors
 *  OrdersPage.test.tsx's mockFetchRouter) — the page fires three GET requests
 *  on mount (tickets list, kpis, admins) whose relative order isn't
 *  guaranteed, so tests match by URL instead of call sequence. */
function mockFetchRouter(overrides: {
  tickets?: unknown;
  kpis?: unknown;
  admins?: unknown;
  onPost?: (url: string, body: unknown) => unknown;
} = {}) {
  const ticketsResponse = overrides.tickets ?? TICKETS_DATA;
  const kpisResponse = overrides.kpis ?? KPIS_DATA;
  const adminsResponse = overrides.admins ?? ADMINS_DATA;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const result = overrides.onPost?.(url, body) ?? { ok: true };
      return jsonResponse(result);
    }
    if (url.startsWith("/api/support/kpis")) return jsonResponse(kpisResponse);
    if (url.startsWith("/api/admins")) return jsonResponse(adminsResponse);
    return jsonResponse(ticketsResponse);
  });
}

/** Finds a filter Select's trigger via the plain-text `<label>` above it (the
 *  FilterBar labels aren't `htmlFor`-connected, so accessible-name lookups
 *  don't work — same pattern as locating a combobox by its neighboring text
 *  in OrdersPage.test.tsx). Filters candidates to actual `<label>` elements
 *  since some labels ("Status", "Category") also appear as DataTable column
 *  headers. */
function selectByLabel(labelText: string): HTMLElement {
  const label = screen.getAllByText(labelText).find((el) => el.tagName === "LABEL");
  if (!label) throw new Error(`No <label> found with text "${labelText}"`);
  const combobox = label.parentElement!.querySelector('[role="combobox"]');
  if (!combobox) throw new Error(`No combobox found next to label "${labelText}"`);
  return combobox as HTMLElement;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them (same shim as VouchersPage.test.tsx / OrdersPage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("SupportPage", () => {
  it("renders the KPI row and ticket rows with customer/status/priority/assignee/category columns", async () => {
    mockFetchRouter();
    render(<SupportPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());
    expect(screen.getByText("Budi")).toBeInTheDocument();
    expect(screen.getByText("2026-06-26")).toBeInTheDocument(); // createdAtDisplay, not a browser-locale computation

    // KPI row (TicketsKpiRow / useTicketsKpis) — "Open"/"Unassigned" text is
    // shared with the StatusBadge/Assigned column below, so scope the lookup
    // to the StatCard container (mirrors OrdersPage.test.tsx's statCard helper).
    function statCard(label: string): HTMLElement {
      const match = screen.getAllByText(label).find((el) => el.closest('[data-slot="card"]'));
      return match!.closest('[data-slot="card"]') as HTMLElement;
    }
    await waitFor(() => expect(within(statCard("Open")).getByText("5")).toBeInTheDocument());
    expect(within(statCard("Unassigned")).getByText("3")).toBeInTheDocument();
    expect(within(statCard("Overdue")).getByText("1")).toBeInTheDocument();

    // Assigned ticket resolves adminId 7 to the admin's name, not a bare id.
    expect(screen.getByText("Rina")).toBeInTheDocument();
    // Unassigned ticket falls back to the literal label in the Assigned column.
    expect(screen.getAllByText("Unassigned").length).toBeGreaterThan(0);
  });

  it("shows the empty state with a Refresh action, and Clear Filters only once a filter is active", async () => {
    mockFetchRouter({ tickets: { ...TICKETS_DATA, tickets: [], total: 0 } });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no open tickets/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("wires the search box and status filter to the q/status params via Apply, and Clear resets them", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = mockFetchRouter();
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());

    const search = screen.getByPlaceholderText("Search message or customer...");
    await user.type(search, "budi");

    const statusSelect = selectByLabel("Status");
    await user.click(statusSelect);
    await user.click(await screen.findByRole("option", { name: "Replied" }));

    await user.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/support?status=REPLIED&q=budi"),
    );

    await user.click(screen.getByRole("button", { name: /^clear$/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/support?"));
  });

  it("bulk-selects rows and only shows the selection toolbar once selected.size > 0", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter();
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());

    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    // The FilterBar also has its own "Clear" button — scope to the bulk
    // toolbar (the div hosting the "N selected" label) to disambiguate.
    const toolbar = screen.getByText("1 selected").closest("div")!;
    await user.click(within(toolbar).getByRole("button", { name: /^clear$/i }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("bulk Resolve posts only the eligible selected ids to /api/support/bulk-action", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let bulkBody: unknown = null;
    mockFetchRouter({
      onPost: (url, body) => {
        if (url === "/api/support/bulk-action") {
          bulkBody = body;
          return { succeeded: [1], failed: [] };
        }
        return { ok: true };
      },
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());

    // Ticket #1 is OPEN (resolvable), #3 is CLOSED (not resolvable) — selecting
    // both proves the bulk bar pre-filters to the eligible subset.
    await user.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));
    await user.click(screen.getByRole("checkbox", { name: "Select ticket #3" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^resolve$/i }));

    await waitFor(() => expect(bulkBody).toEqual({ ids: [1], action: "resolve" }));
    await waitFor(() => expect(screen.getByText(/1 succeeded, 0 failed/)).toBeInTheDocument());
  });

  it("bulk Close posts eligible ids to /api/support/bulk-action with action close", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let bulkBody: unknown = null;
    mockFetchRouter({
      onPost: (url, body) => {
        if (url === "/api/support/bulk-action") {
          bulkBody = body;
          return { succeeded: [1, 2], failed: [] };
        }
        return { ok: true };
      },
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));
    await user.click(screen.getByRole("checkbox", { name: "Select ticket #2" }));
    await user.click(screen.getByRole("button", { name: /^close$/i }));

    await waitFor(() => expect(bulkBody).toEqual({ ids: [1, 2], action: "close" }));
  });

  it("bulk Assign opens the shared dialog and posts to /api/support/bulk-action with action assign", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let bulkBody: unknown = null;
    mockFetchRouter({
      onPost: (url, body) => {
        if (url === "/api/support/bulk-action") {
          bulkBody = body;
          return { succeeded: [1, 2], failed: [] };
        }
        return { ok: true };
      },
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));
    await user.click(screen.getByRole("checkbox", { name: "Select ticket #2" }));
    await user.click(screen.getByRole("button", { name: /^assign$/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Assign 2 tickets?")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("combobox", { name: "Assignee" }));
    await user.click(await screen.findByRole("option", { name: "Telegram ID 111" }));
    await user.click(within(dialog).getByRole("button", { name: /^confirm$/i }));

    await waitFor(() => expect(bulkBody).toEqual({ ids: [1, 2], action: "assign", adminId: 9 }));
  });

  it("row action menu contents vary by status: OPEN shows Resolve and Close but not Reopen", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter();
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for ticket #1" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Resolve")).toBeInTheDocument();
    expect(within(menu).getByText("Close")).toBeInTheDocument();
    expect(within(menu).queryByText("Reopen")).not.toBeInTheDocument();
  });

  it("row action menu: CLOSED ticket shows Reopen but not Resolve/Close, and posts to /:id/reopen", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let reopened = false;
    mockFetchRouter({
      onPost: (url) => {
        if (url === "/api/support/3/reopen") reopened = true;
        return { ok: true };
      },
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Question about product")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for ticket #3" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("Resolve")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Close")).not.toBeInTheDocument();
    expect(within(menu).getByText("Reopen")).toBeInTheDocument();

    await user.click(within(menu).getByText("Reopen"));
    await waitFor(() => expect(reopened).toBe(true));
  });

  it("row action Assign opens the dialog pre-selected to the ticket's current admin and reassigns via /:id/assign", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let assignBody: unknown = null;
    mockFetchRouter({
      onPost: (url, body) => {
        if (url === "/api/support/2/assign") assignBody = body;
        return { ok: true };
      },
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Refund request")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for ticket #2" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Assign"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Assign this ticket?")).toBeInTheDocument();
    // Ticket #2 is already assigned to Rina (adminId 7) — pre-selected value.
    expect(within(dialog).getByRole("combobox", { name: "Assignee" })).toHaveTextContent("Rina");

    await user.click(within(dialog).getByRole("combobox", { name: "Assignee" }));
    await user.click(await screen.findByRole("option", { name: "Unassigned" }));
    await user.click(within(dialog).getByRole("button", { name: /^confirm$/i }));

    await waitFor(() => expect(assignBody).toEqual({ adminId: null }));
  });

  it("Export links to /api/support/export with the selected ticket ids", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter();
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));
    await user.click(screen.getByRole("checkbox", { name: "Select ticket #2" }));

    const exportLink = screen.getByRole("link", { name: /export/i });
    expect(exportLink).toHaveAttribute("href", "/api/support/export?ids=1,2");
  });

  describe("row action: Order History", () => {
    it("navigates to /orders?q=<identifier> for a customer with an identifiable field", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      mockFetchRouter();
      render(<SupportPage />, { wrapper: WrapperWithLocation });
      await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Actions for ticket #1" }));
      const menu = await screen.findByRole("menu");
      // Ticket #1's customer has no username but does have a telegramId ("555").
      await user.click(within(menu).getByText("Order History"));

      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/orders?q=555"));
    });

    it("is disabled — and does not navigate to a dead /orders?q=null search — for a web-only customer with no username or telegramId", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      mockFetchRouter({ tickets: { ...TICKETS_DATA, tickets: [TICKET_WEB_ONLY_CUSTOMER], total: 1 } });
      render(<SupportPage />, { wrapper: WrapperWithLocation });
      await waitFor(() => expect(screen.getByText("Payment not reflecting")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Actions for ticket #4" }));
      const menu = await screen.findByRole("menu");
      const orderHistoryItem = within(menu).getByText("Order History").closest('[role="menuitem"]')!;
      expect(orderHistoryItem).toHaveAttribute("data-disabled");

      await user.click(within(menu).getByText("Order History"));
      // Disabled Radix menu items don't fire onSelect — location must stay put.
      expect(screen.getByTestId("location")).toHaveTextContent("/");
      expect(screen.queryByTestId("location")).not.toHaveTextContent("/orders");
    });
  });
});
