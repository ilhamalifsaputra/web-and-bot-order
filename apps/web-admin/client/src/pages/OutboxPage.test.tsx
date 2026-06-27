import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  sentAt: "2026-06-26T10:00:05.000Z",
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
    expect(screen.getAllByText("SENT").length).toBeGreaterThan(0);
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
});
