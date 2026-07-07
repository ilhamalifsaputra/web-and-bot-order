import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OutboxPage } from "./OutboxPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const ROW = {
  id: 7,
  event: "ORDER_DELIVERED",
  orderId: 42,
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
    await waitFor(() => expect(screen.getByText("ORDER_DELIVERED")).toBeInTheDocument());
    expect(screen.getAllByText("Sent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-06-26 17:00").length).toBeGreaterThan(0); // createdAtDisplay/sentAtDisplay
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

  it("shows an alert when retrying a notification fails", async () => {
    const failedRow = { ...ROW, id: 9, status: "FAILED" };
    const alertSpy = vi.spyOn(globalThis, "alert").mockImplementation(() => {});
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

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith("That notification no longer exists."),
    );
  });
});
