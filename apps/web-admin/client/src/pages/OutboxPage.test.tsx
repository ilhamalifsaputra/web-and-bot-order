import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { OutboxPage } from "./OutboxPage";

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

const ROW = {
  id: 7,
  event: "ORDER_DELIVERED",
  orderId: 42,
  channel: "TELEGRAM",
  status: "SENT",
  attempts: 1,
  lastError: null,
  createdAt: "2026-06-26T10:00:00.000Z",
  createdAtDisplay: "2026-06-26 17:00",
  sentAt: "2026-06-26T10:00:05.000Z",
  sentAtDisplay: "2026-06-26 17:00",
};

beforeEach(() => { vi.restoreAllMocks(); });

describe("OutboxPage", () => {
  it("shows outbox rows from /api/outbox", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ rows: [ROW], total: 1, page: 1, hasNext: false, counts: { SENT: 1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OutboxPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order delivered")).toBeInTheDocument());
    expect(screen.getByText("Order delivered")).toHaveAttribute("title", "ORDER_DELIVERED");
    expect(screen.getAllByText("Sent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-06-26 17:00").length).toBeGreaterThan(0); // createdAtDisplay/sentAtDisplay
  });

  it("renders a distinct channel badge for TELEGRAM vs EMAIL rows", async () => {
    const telegramRow = { ...ROW, id: 1, channel: "TELEGRAM" };
    const emailRow = { ...ROW, id: 2, event: "OWNER_EMAIL_NEW_TICKET", channel: "EMAIL" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ rows: [telegramRow, emailRow], total: 2, page: 1, hasNext: false, counts: { SENT: 2 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OutboxPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Telegram")).toBeInTheDocument());
    const telegramBadge = screen.getByText("Telegram");
    const emailBadge = screen.getByText("Email");
    expect(telegramBadge).toBeInTheDocument();
    expect(emailBadge).toBeInTheDocument();
    // Visibly different tone classes, not just different text.
    expect(telegramBadge.className).toContain("bg-sand");
    expect(emailBadge.className).toContain("bg-pine-tint");
    expect(telegramBadge.className).not.toEqual(emailBadge.className);
  });

  it("renders readable labels for the four owner-email events instead of falling back to humanizeEventCode", async () => {
    const rows = [
      { ...ROW, id: 1, event: "OWNER_EMAIL_ORDER_PAID", channel: "EMAIL" },
      { ...ROW, id: 2, event: "OWNER_EMAIL_MANUAL_ORDER_QUEUED", channel: "EMAIL" },
      { ...ROW, id: 3, event: "OWNER_EMAIL_NEW_TICKET", channel: "EMAIL" },
      { ...ROW, id: 4, event: "OWNER_EMAIL_TICKET_REPLY", channel: "EMAIL" },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ rows, total: 4, page: 1, hasNext: false, counts: { SENT: 4 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OutboxPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Owner email: order paid")).toBeInTheDocument());
    expect(screen.getByText("Owner email: manual order queued")).toBeInTheDocument();
    expect(screen.getByText("Owner email: new ticket")).toBeInTheDocument();
    expect(screen.getByText("Owner email: ticket reply")).toBeInTheDocument();
    // None of these should have fallen back to the raw enum via humanizeEventCode.
    expect(screen.queryByText("Owner Email Order Paid")).not.toBeInTheDocument();
  });

  it("shows empty state when no rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ rows: [], total: 0, page: 1, hasNext: false, counts: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OutboxPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no notifications/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<OutboxPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("retries a failed notification via /api/outbox/:id/retry and refetches", async () => {
    const failedRow = { ...ROW, id: 9, status: "FAILED" };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ rows: [failedRow], total: 1, page: 1, hasNext: false, counts: { FAILED: 1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ rows: [{ ...failedRow, status: "PENDING" }], total: 1, page: 1, hasNext: false, counts: { PENDING: 1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OutboxPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/outbox/9/retry", expect.objectContaining({ method: "POST" })),
    );
    await waitFor(() => expect(screen.getAllByText("Pending").length).toBeGreaterThan(0));
  });

  it("shows a toast when retrying a notification fails", async () => {
    const failedRow = { ...ROW, id: 9, status: "FAILED" };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ rows: [failedRow], total: 1, page: 1, hasNext: false, counts: { FAILED: 1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    // Simulate POST /api/outbox/9/retry returning 404 error with server message
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "That notification no longer exists." }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OutboxPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("That notification no longer exists.")).toBeInTheDocument();
  });
});
