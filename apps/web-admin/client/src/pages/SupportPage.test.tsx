import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { SupportPage } from "./SupportPage";

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          {children}
          <Toaster />
        </QueryClientProvider>
      </MemoryRouter>
    );
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return makeWrapper(qc)({ children });
}

/** Renders SupportPage at /support with a real sibling route at
 *  /support/:ticketId, so a test can assert that clicking "View" actually
 *  navigates there (not just that the menu item exists). */
function WrapperWithDetailRoute({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/support"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/support" element={children} />
          <Route path="/support/:ticketId" element={<div>ticket-detail-page</div>} />
        </Routes>
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const STATS = { open: 3, waitingCustomer: 2, overdue: 1, unassigned: 4, resolvedToday: 5 };

const TICKET_OPEN = {
  id: 1,
  userId: 10,
  message: "Order tidak sampai, mohon bantuannya untuk dicek ya kak",
  status: "OPEN",
  priority: "HIGH",
  adminId: null,
  createdAt: "2026-06-26T10:00:00.000Z",
  createdAtDisplay: "2026-06-26",
  repliedAt: null,
  repliedAtDisplay: null,
  isOverdue: true,
  user: { id: 10, fullName: "Budi", username: null },
};

const TICKET_REPLIED = {
  id: 2,
  userId: 11,
  message: "Refund request",
  status: "REPLIED",
  priority: "MEDIUM",
  adminId: 7,
  createdAt: "2026-06-20T10:00:00.000Z",
  createdAtDisplay: "2026-06-20",
  repliedAt: "2026-06-21T10:00:00.000Z",
  repliedAtDisplay: "2026-06-21",
  isOverdue: false,
  user: { id: 11, fullName: "Sari", username: null },
};

const ADMIN_ROW = { id: 7, telegramId: 555, name: "Rina" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function supportData(
  items: unknown[],
  overrides: Partial<{ total: number; page: number; pageSize: number; stats: typeof STATS }> = {},
) {
  return {
    items,
    total: overrides.total ?? items.length,
    page: overrides.page ?? 1,
    pageSize: overrides.pageSize ?? 20,
    stats: overrides.stats ?? STATS,
  };
}

/** Routes fetch by URL/method against small per-test overrides — the page
 *  fires two GET requests on mount (ticket list + admins) whose relative
 *  order isn't guaranteed, so tests match by URL instead of call sequence
 *  (mirrors OrdersPage.test.tsx's mockFetchRouter). */
function mockFetchRouter(
  overrides: {
    support?: unknown;
    admins?: unknown;
    onPost?: (url: string, body: unknown) => unknown;
  } = {},
) {
  const supportResponse = overrides.support ?? supportData([TICKET_OPEN, TICKET_REPLIED]);
  const adminsResponse = overrides.admins ?? { admins: [ADMIN_ROW] };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const result = overrides.onPost?.(url, body) ?? { ok: true };
      return jsonResponse(result);
    }
    if (url.startsWith("/api/admins")) return jsonResponse(adminsResponse);
    return jsonResponse(supportResponse);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select/Popover use pointer-capture APIs and scrollIntoView — jsdom
  // doesn't implement them (same shim as VouchersPage.test.tsx / OrdersPage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("SupportPage", () => {
  it("renders ticket rows with a message excerpt (no subject field) and the customer's name", async () => {
    mockFetchRouter();
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());
    expect(screen.getByText("Budi")).toBeInTheDocument();
    expect(screen.getByText("Refund request")).toBeInTheDocument();
    expect(screen.getByText("Sari")).toBeInTheDocument();
    expect(screen.getByText("2026-06-26")).toBeInTheDocument(); // createdAtDisplay, not a browser-locale computation
  });

  it("shows a KPI row sourced from the server-wide stats field", async () => {
    mockFetchRouter({
      support: supportData([TICKET_OPEN], {
        stats: { open: 12, waitingCustomer: 4, overdue: 2, unassigned: 6, resolvedToday: 9 },
      }),
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());

    function statCard(label: string): HTMLElement {
      const match = screen.getAllByText(label).find((el) => el.closest('[data-slot="card"]'));
      return match!.closest('[data-slot="card"]') as HTMLElement;
    }

    expect(within(statCard("Open")).getByText("12")).toBeInTheDocument();
    expect(within(statCard("Waiting Customer")).getByText("4")).toBeInTheDocument();
    expect(within(statCard("Overdue")).getByText("2")).toBeInTheDocument();
    expect(within(statCard("Unassigned")).getByText("6")).toBeInTheDocument();
    expect(within(statCard("Resolved Today")).getByText("9")).toBeInTheDocument();
  });

  it("shows an Overdue chip only for rows flagged isOverdue", async () => {
    mockFetchRouter();
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());

    const rows = screen.getAllByRole("row");
    const rowFor = (text: string) => rows.find((r) => within(r).queryByText(text));

    expect(within(rowFor("#1")!).getByText("Overdue")).toBeInTheDocument();
    expect(within(rowFor("#2")!).queryByText("Overdue")).not.toBeInTheDocument();
  });

  it("shows the full message text in a popover on hovering the Ticket cell", async () => {
    const longMessage = "Order saya belum sampai setelah lebih dari seminggu, bisa tolong dicek statusnya?";
    mockFetchRouter({ support: supportData([{ ...TICKET_OPEN, message: longMessage }]) });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());

    expect(screen.getAllByText(longMessage)).toHaveLength(1);
    // React's onMouseEnter is implemented on top of native "mouseover" (it
    // doesn't attach a literal "mouseenter" listener), so fireEvent.mouseOver
    // is what actually reaches the handler here — fireEvent.mouseEnter would
    // silently no-op.
    fireEvent.mouseOver(screen.getByText(longMessage).parentElement!);
    await waitFor(() => expect(screen.getAllByText(longMessage)).toHaveLength(2));
  });

  it("shows the genuinely-empty state with a Refresh action and no Clear Filters", async () => {
    mockFetchRouter({ support: supportData([]) });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no support tickets/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it("shows the filtered-empty state (with Clear Filters) once a status filter narrows to nothing", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = mockFetchRouter();
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());

    fetchSpy.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST") return jsonResponse({ ok: true });
      if (url.startsWith("/api/admins")) return jsonResponse({ admins: [ADMIN_ROW] });
      return jsonResponse(supportData([]));
    });

    await user.click(screen.getByRole("combobox", { name: "Status filter" }));
    await user.click(await screen.findByRole("option", { name: "Closed" }));
    await user.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() => expect(screen.getByText(/no matching tickets/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument();
  });

  it("debounces a search into the q query param", async () => {
    vi.useFakeTimers();
    const fetchSpy = mockFetchRouter({ support: supportData([]) });
    render(<SupportPage />, { wrapper: Wrapper });
    await vi.waitFor(() => expect(screen.getByText(/no support tickets/i)).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/search ticket message/i);
    fireEvent.change(search, { target: { value: "refund" } });
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining("q=refund"));

    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("q=refund")));
    vi.useRealTimers();
  });

  it("applies status, priority, assigned and sort filters as server query params via Apply", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = mockFetchRouter();
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());

    await user.click(screen.getByRole("combobox", { name: "Status filter" }));
    await user.click(await screen.findByRole("option", { name: "Waiting Customer" }));

    await user.click(screen.getByRole("combobox", { name: "Priority filter" }));
    await user.click(await screen.findByRole("option", { name: "High" }));

    await user.click(screen.getByRole("combobox", { name: "Assigned filter" }));
    await user.click(await screen.findByRole("option", { name: "Unassigned" }));

    await user.click(screen.getByRole("combobox", { name: "Sort" }));
    await user.click(await screen.findByRole("option", { name: "Priority" }));

    await user.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/support?status=REPLIED&priority=HIGH&assigned=unassigned&sort=priority",
      ),
    );
  });

  it("resolves an assigned ticket's adminId to the admin's name in the Assigned column, and lets you reassign it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let assignUrl: string | null = null;
    let assignBody: unknown = null;
    mockFetchRouter({
      support: supportData([TICKET_REPLIED]),
      admins: { admins: [ADMIN_ROW, { id: 9, telegramId: 111, name: null }] },
      onPost: (url, body) => {
        assignUrl = url;
        assignBody = body;
        return { ok: true };
      },
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Refund request")).toBeInTheDocument());

    const assigneeTrigger = await screen.findByRole("combobox", { name: "Assignee for ticket #2" });
    expect(assigneeTrigger).toHaveTextContent("Rina");

    await user.click(assigneeTrigger);
    await waitFor(() => screen.getByRole("option", { name: "Telegram ID 111" }));
    await user.click(screen.getByRole("option", { name: "Telegram ID 111" }));

    await waitFor(() => {
      expect(assignUrl).toBe("/api/support/2/assign");
      expect(assignBody).toEqual({ adminId: 9 });
    });
  });

  it("bulk-closes selected tickets via the sticky bulk bar", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let bulkBody: unknown = null;
    const fetchSpy = mockFetchRouter({
      onPost: (url, body) => {
        if (url === "/api/support/bulk-action") {
          bulkBody = body;
          return { succeeded: [1, 2], failed: [] };
        }
        return { ok: true };
      },
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));
    await user.click(screen.getByRole("checkbox", { name: "Select ticket #2" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /close 2 tickets/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^close$/i }));

    await waitFor(() => expect(bulkBody).toEqual({ ids: [1, 2], action: "close" }));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/support/bulk-action",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("bulk-assigns selected tickets to an admin via the sticky bulk bar", async () => {
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
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));
    await user.click(screen.getByRole("checkbox", { name: "Select ticket #2" }));

    await user.click(screen.getByRole("combobox", { name: "Assign selected tickets to" }));
    await user.click(await screen.findByRole("option", { name: "Rina" }));

    await waitFor(() => expect(bulkBody).toEqual({ ids: [1, 2], action: "assign", adminId: 7 }));
  });

  it("bulk-sets priority for selected tickets via the sticky bulk bar", async () => {
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
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));

    await user.click(screen.getByRole("combobox", { name: "Set priority for selected tickets" }));
    await user.click(await screen.findByRole("option", { name: "Urgent" }));

    await waitFor(() => expect(bulkBody).toEqual({ ids: [1], action: "priority", priority: "URGENT" }));
  });

  it("never offers delete or merge in the bulk bar or the row-actions dropdown", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter();
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /merge/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions for ticket #1" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText(/delete/i)).not.toBeInTheDocument();
    expect(within(menu).queryByText(/merge/i)).not.toBeInTheDocument();
  });

  it("row-actions dropdown: View navigates to the ticket detail page without calling the API", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = mockFetchRouter({ support: supportData([TICKET_OPEN]) });
    render(<SupportPage />, { wrapper: WrapperWithDetailRoute });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for ticket #1" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Assign")).toBeInTheDocument();
    await user.click(within(menu).getByText("View"));

    await waitFor(() => expect(screen.getByText("ticket-detail-page")).toBeInTheDocument());
    // Navigating is a pure client-side route change — it must never have
    // POSTed to a per-ticket action endpoint.
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/support\/1\//),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("row-actions dropdown: Close opens a confirm dialog that posts to /:id/close", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let closedUrl: string | null = null;
    mockFetchRouter({
      support: supportData([TICKET_OPEN]),
      onPost: (url) => {
        if (url === "/api/support/1/close") closedUrl = url;
        return { ok: true };
      },
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for ticket #1" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("View")).toBeInTheDocument();

    await user.click(within(menu).getByText("Close"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^close$/i }));

    await waitFor(() => expect(closedUrl).toBe("/api/support/1/close"));
  });

  it("doesn't double-toast when the admin's own Close action causes the next refetch to see the ticket as CLOSED", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let closed = false;
    let supportGetCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST") {
        if (url === "/api/support/1/close") closed = true;
        return jsonResponse({ ok: true });
      }
      if (url.startsWith("/api/admins")) return jsonResponse({ admins: [ADMIN_ROW] });
      supportGetCount += 1;
      // Once closed, the invalidated refetch (triggered by the mutation
      // itself) genuinely reports status: CLOSED — this must not ALSO
      // produce a diff-toast on top of the mutation's own success toast.
      return jsonResponse(supportData([{ ...TICKET_OPEN, status: closed ? "CLOSED" : "OPEN" }]));
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());
    const getCountAfterMount = supportGetCount;

    await user.click(screen.getByRole("button", { name: "Actions for ticket #1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Close"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^close$/i }));

    await waitFor(() => expect(screen.getByText("Ticket closed.")).toBeInTheDocument());
    // Wait for the invalidated refetch (triggered by the mutation itself) to
    // actually land — that's the fetch whose CLOSED status could wrongly
    // trigger a second diff-toast — before asserting it didn't.
    await waitFor(() => expect(supportGetCount).toBeGreaterThan(getCountAfterMount));

    expect(screen.queryByText(/status changed to Closed/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Ticket closed.")).toHaveLength(1);
  });

  it("bulk-closes selected tickets without a duplicate diff-toast on the next refetch", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let closedIds: number[] = [];
    let supportGetCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST") {
        if (url === "/api/support/bulk-action") {
          closedIds = [1, 2];
          return jsonResponse({ succeeded: [1, 2], failed: [] });
        }
        return jsonResponse({ ok: true });
      }
      if (url.startsWith("/api/admins")) return jsonResponse({ admins: [ADMIN_ROW] });
      supportGetCount += 1;
      return jsonResponse(
        supportData([
          { ...TICKET_OPEN, status: closedIds.includes(1) ? "CLOSED" : "OPEN" },
          { ...TICKET_REPLIED, status: closedIds.includes(2) ? "CLOSED" : "REPLIED" },
        ]),
      );
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());
    const getCountAfterMount = supportGetCount;

    await user.click(screen.getByRole("checkbox", { name: "Select ticket #1" }));
    await user.click(screen.getByRole("checkbox", { name: "Select ticket #2" }));
    await user.click(screen.getByRole("button", { name: /close 2 tickets/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^close$/i }));

    await waitFor(() => expect(screen.getByText(/Closed 2 tickets/)).toBeInTheDocument());
    await waitFor(() => expect(supportGetCount).toBeGreaterThan(getCountAfterMount));

    expect(screen.queryByText(/status changed to Closed/i)).not.toBeInTheDocument();
  });

  it("paginates via the shared Pagination component and resets to page 1 on a page-size change", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = mockFetchRouter({
      support: supportData([TICKET_OPEN, TICKET_REPLIED], { total: 45 }),
    });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());
    expect(screen.getByText(/showing 1–20 of 45/i)).toBeInTheDocument();

    fetchSpy.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST") return jsonResponse({ ok: true });
      if (url.startsWith("/api/admins")) return jsonResponse({ admins: [ADMIN_ROW] });
      return jsonResponse(supportData([TICKET_OPEN], { total: 45, page: 2 }));
    });
    await user.click(screen.getByRole("button", { name: "Go to page 2" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("page=2")));

    await user.click(screen.getByRole("combobox", { name: /rows per page/i }));
    await user.click(await screen.findByText("50 / page"));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("pageSize=50")));
    // Changing the page size resets to page 1 — the request must not still carry page=2.
    const lastPageSizeCall = fetchSpy.mock.calls
      .map(([url]) => (typeof url === "string" ? url : url!.toString()))
      .filter((url) => url.includes("pageSize=50"))
      .at(-1)!;
    expect(lastPageSizeCall).not.toContain("page=2");
  });

  it("fires a live-update toast on a diffed poll for a new ticket and a status change, but not on the first load", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockFetchRouter({ support: supportData([TICKET_OPEN]) });
    render(<SupportPage />, { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(screen.getByText(/Order tidak sampai/)).toBeInTheDocument());

    expect(screen.queryByText(/New ticket/)).not.toBeInTheDocument();
    expect(screen.queryByText(/status changed/)).not.toBeInTheDocument();

    // Simulate what the 30s poll would surface: ticket #1 flips to REPLIED,
    // and a brand-new ticket #3 shows up.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST") return jsonResponse({ ok: true });
      if (url.startsWith("/api/admins")) return jsonResponse({ admins: [ADMIN_ROW] });
      return jsonResponse(
        supportData([{ ...TICKET_OPEN, status: "REPLIED" }, { ...TICKET_REPLIED, id: 3, status: "OPEN" }]),
      );
    });

    await qc.invalidateQueries({ queryKey: ["support"] });

    await waitFor(() => expect(screen.getByText(/Ticket #1 status changed to Waiting Customer/)).toBeInTheDocument());
    expect(screen.getByText(/New ticket #3 from Sari/)).toBeInTheDocument();
  });
});
