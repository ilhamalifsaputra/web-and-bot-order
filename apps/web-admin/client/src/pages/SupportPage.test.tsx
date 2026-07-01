import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SupportPage } from "./SupportPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const TICKET = { id: 1, subject: "Order tidak sampai", status: "OPEN", adminId: null, createdAt: "2026-06-26T10:00:00.000Z", user: { fullName: "Budi", username: null } };
const REPLIED_TICKET = { id: 2, subject: "Refund request", status: "REPLIED", adminId: 7, createdAt: "2026-06-20T10:00:00.000Z", user: { fullName: "Sari", username: null } };
const ADMIN_ROW = { id: 7, telegramId: 555, name: "Rina" };

function mockFetch(...responses: Array<Record<string, unknown>>) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const body of responses) {
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }
  return spy;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them (same shim as VouchersPage.test.tsx / ProductCreatePage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("SupportPage", () => {
  it("renders open tickets", async () => {
    mockFetch({ tickets: [TICKET] }, { admins: [] });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());
    expect(screen.getByText("Budi")).toBeInTheDocument();
  });

  it("shows empty state when no tickets", async () => {
    mockFetch({ tickets: [] }, { admins: [] });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no open tickets/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("resolves an assigned ticket's adminId to the admin's name, and lets you reassign it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const postSpy = mockFetch({ tickets: [REPLIED_TICKET] }, { admins: [ADMIN_ROW, { id: 9, telegramId: 111, name: null }] });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Refund request")).toBeInTheDocument());

    // adminId 7 resolves to "Rina" (not a bare id number) in the assignee cell.
    const assigneeTrigger = await screen.findByRole("combobox", { name: "Assignee for ticket #2" });
    expect(assigneeTrigger).toHaveTextContent("Rina");

    postSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await user.click(assigneeTrigger);
    await waitFor(() => screen.getByRole("option", { name: "Telegram ID 111" }));
    await user.click(screen.getByRole("option", { name: "Telegram ID 111" }));

    await waitFor(() => {
      const call = postSpy.mock.calls.find(([url]) => url === "/api/support/2/assign");
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ adminId: 9 });
    });
  });

  it("filters tickets by status", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetch({ tickets: [TICKET, REPLIED_TICKET] }, { admins: [ADMIN_ROW] });
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());
    expect(screen.getByText("Refund request")).toBeInTheDocument();

    const statusFilter = screen.getByRole("combobox", { name: "Status filter" });
    await user.click(statusFilter);
    await waitFor(() => screen.getByRole("option", { name: "REPLIED" }));
    await user.click(screen.getByRole("option", { name: "REPLIED" }));

    expect(screen.getByText("Refund request")).toBeInTheDocument();
    expect(screen.queryByText("Order tidak sampai")).not.toBeInTheDocument();

    await user.click(statusFilter);
    await waitFor(() => screen.getByRole("option", { name: "All" }));
    await user.click(screen.getByRole("option", { name: "All" }));

    expect(screen.getByText("Order tidak sampai")).toBeInTheDocument();
    expect(screen.getByText("Refund request")).toBeInTheDocument();
  });
});
