import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TasksPage } from "./TasksPage";

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

/** Renders TasksPage at /tasks with a real sibling route at /orders/:orderId,
 *  so a test can assert the Reference link actually navigates there. */
function WrapperWithOrderRoute({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/tasks"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/tasks" element={children} />
          <Route path="/orders/:orderId" element={<div>order-detail-page</div>} />
        </Routes>
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const STATS = { pending: 2, assigned: 1, inProgress: 1, escalated: 0 };
const ADMIN_ROW = { id: 7, telegramId: 555, name: "Rina" };

const TASK_PENDING = {
  id: 1,
  type: "MANUAL_DELIVERY",
  status: "PENDING",
  priority: "HIGH",
  assignedTo: null,
  assigneeName: null,
  order: { id: 10, orderCode: "ORD-010" },
  orderItem: null,
  refund: null,
  dueAt: null,
  dueAtDisplay: null,
  completedAt: null,
  completedAtDisplay: null,
  createdAt: "2026-06-26T10:00:00.000Z",
  createdAtDisplay: "2026-06-26",
};

const TASK_ASSIGNED = {
  ...TASK_PENDING,
  id: 2,
  type: "REFUND_REVIEW",
  status: "ASSIGNED",
  priority: "MEDIUM",
  assignedTo: 7,
  assigneeName: "Rina",
  order: { id: 11, orderCode: "ORD-011" },
  refund: { id: 5, amount: "50000", currency: "IDR", status: "PENDING" },
};

const TASK_COMPLETED = {
  ...TASK_PENDING,
  id: 3,
  status: "COMPLETED",
  completedAt: "2026-06-27T10:00:00.000Z",
  completedAtDisplay: "2026-06-27",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function tasksData(
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

function mockFetchRouter(
  overrides: {
    tasks?: unknown;
    admins?: unknown;
    onPost?: (url: string, body: unknown) => unknown;
  } = {},
) {
  const tasksResponse = overrides.tasks ?? tasksData([TASK_PENDING, TASK_ASSIGNED]);
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
    return jsonResponse(tasksResponse);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select/DropdownMenu use pointer-capture APIs jsdom doesn't
  // implement (same shim as SupportPage.test.tsx/OrdersPage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("TasksPage", () => {
  it("renders task rows with a human-readable type label and the order reference", async () => {
    mockFetchRouter();
    render(<TasksPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Manual Delivery")).toBeInTheDocument());
    expect(screen.getByText("Refund Review")).toBeInTheDocument();
    expect(screen.getByText("ORD-010")).toBeInTheDocument();
    expect(screen.getByText(/Refund #5/)).toBeInTheDocument();
  });

  it("shows a KPI row sourced from the server-wide stats field", async () => {
    mockFetchRouter({
      tasks: tasksData([TASK_PENDING], { stats: { pending: 5, assigned: 2, inProgress: 3, escalated: 1 } }),
    });
    render(<TasksPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Manual Delivery")).toBeInTheDocument());

    function statCard(label: string): HTMLElement {
      const match = screen.getAllByText(label).find((el) => el.closest('[data-slot="card"]'));
      return match!.closest('[data-slot="card"]') as HTMLElement;
    }
    expect(within(statCard("Pending")).getByText("5")).toBeInTheDocument();
    expect(within(statCard("Assigned")).getByText("2")).toBeInTheDocument();
    expect(within(statCard("In Progress")).getByText("3")).toBeInTheDocument();
    expect(within(statCard("Escalated")).getByText("1")).toBeInTheDocument();
  });

  it("applies type, status, priority and assignee filters as server query params via Apply", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = mockFetchRouter();
    render(<TasksPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Manual Delivery")).toBeInTheDocument());

    await user.click(screen.getByRole("combobox", { name: "Type filter" }));
    await user.click(await screen.findByRole("option", { name: "Manual Delivery" }));

    await user.click(screen.getByRole("combobox", { name: "Status filter" }));
    await user.click(await screen.findByRole("option", { name: "Pending" }));

    await user.click(screen.getByRole("combobox", { name: "Priority filter" }));
    await user.click(await screen.findByRole("option", { name: "High" }));

    await user.click(screen.getByRole("combobox", { name: "Assignee filter" }));
    await user.click(await screen.findByRole("option", { name: "Unassigned" }));

    await user.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin-tasks?type=MANUAL_DELIVERY&status=PENDING&priority=HIGH&assignedTo=unassigned",
      ),
    );
  });

  it("shows the genuinely-empty state with a Refresh action and no Clear Filters", async () => {
    mockFetchRouter({ tasks: tasksData([]) });
    render(<TasksPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no admin tasks/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it("Assignee column: a PENDING/ESCALATED task's Select posts {from, assignedTo} to /:taskId/assign", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let assignUrl: string | null = null;
    let assignBody: unknown = null;
    mockFetchRouter({
      tasks: tasksData([TASK_PENDING]),
      onPost: (url, body) => {
        assignUrl = url;
        assignBody = body;
        return { ok: true };
      },
    });
    render(<TasksPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Manual Delivery")).toBeInTheDocument());

    const assigneeTrigger = await screen.findByRole("combobox", { name: "Assignee for task #1" });
    expect(assigneeTrigger).toHaveTextContent("Unassigned");
    await user.click(assigneeTrigger);
    await user.click(await screen.findByRole("option", { name: "Rina" }));

    await waitFor(() => {
      expect(assignUrl).toBe("/api/admin-tasks/1/assign");
      expect(assignBody).toEqual({ from: "PENDING", assignedTo: 7 });
    });
    await waitFor(() => expect(screen.getByText("Task assigned.")).toBeInTheDocument());
  });

  it("Assignee column: an ASSIGNED task (assign no longer legal) shows plain text, not a Select", async () => {
    mockFetchRouter({ tasks: tasksData([TASK_ASSIGNED]) });
    render(<TasksPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Refund Review")).toBeInTheDocument());
    expect(screen.getByText("Rina")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Assignee for task #2" })).not.toBeInTheDocument();
  });

  it("row-actions dropdown: Start posts {from} to /:taskId/start (only offered once assigned)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let startUrl: string | null = null;
    let startBody: unknown = null;
    mockFetchRouter({
      tasks: tasksData([TASK_ASSIGNED]),
      onPost: (url, body) => {
        if (url === "/api/admin-tasks/2/start") {
          startUrl = url;
          startBody = body;
        }
        return { ok: true };
      },
    });
    render(<TasksPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Refund Review")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for task #2" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("Complete")).not.toBeInTheDocument();
    await user.click(within(menu).getByText("Start"));

    await waitFor(() => {
      expect(startUrl).toBe("/api/admin-tasks/2/start");
      expect(startBody).toEqual({ from: "ASSIGNED" });
    });
  });

  it("row-actions dropdown: Complete opens a confirm dialog that posts {from} to /:taskId/complete", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const inProgress = { ...TASK_ASSIGNED, id: 4, status: "IN_PROGRESS" };
    let completeUrl: string | null = null;
    let completeBody: unknown = null;
    mockFetchRouter({
      tasks: tasksData([inProgress]),
      onPost: (url, body) => {
        if (url === "/api/admin-tasks/4/complete") {
          completeUrl = url;
          completeBody = body;
        }
        return { ok: true };
      },
    });
    render(<TasksPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Refund Review")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for task #4" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Complete"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^complete$/i }));

    await waitFor(() => {
      expect(completeUrl).toBe("/api/admin-tasks/4/complete");
      expect(completeBody).toEqual({ from: "IN_PROGRESS" });
    });
  });

  it("row-actions dropdown: Escalate posts {from} directly (no confirm) to /:taskId/escalate", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let escalateBody: unknown = null;
    mockFetchRouter({
      tasks: tasksData([TASK_PENDING]),
      onPost: (url, body) => {
        if (url === "/api/admin-tasks/1/escalate") escalateBody = body;
        return { ok: true };
      },
    });
    render(<TasksPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Manual Delivery")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for task #1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Escalate"));

    await waitFor(() => expect(escalateBody).toEqual({ from: "PENDING" }));
  });

  it("a completed (terminal) task offers no actions menu", async () => {
    mockFetchRouter({ tasks: tasksData([TASK_COMPLETED]) });
    render(<TasksPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Manual Delivery")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Actions for task #3" })).not.toBeInTheDocument();
  });

  it("the Reference link navigates to the linked order's detail page", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter({ tasks: tasksData([TASK_PENDING]) });
    render(<TasksPage />, { wrapper: WrapperWithOrderRoute });
    await waitFor(() => expect(screen.getByText("ORD-010")).toBeInTheDocument());

    await user.click(screen.getByText("ORD-010"));
    await waitFor(() => expect(screen.getByText("order-detail-page")).toBeInTheDocument());
  });
});
