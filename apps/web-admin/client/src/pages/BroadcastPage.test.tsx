import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BroadcastPage } from "./BroadcastPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const BROADCAST = { id: 1, message: "Hello customers!", segment: "ALL", status: "SENT", total: 100, sent: 100, scheduledAt: null, createdAt: "2026-06-26T10:00:00.000Z" };

beforeEach(() => { vi.restoreAllMocks(); });

describe("BroadcastPage", () => {
  it("renders broadcast history", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: ["ALL", "ACTIVE"], counts: { ALL: 200 }, history: [BROADCAST] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/Hello customers!/)).toBeInTheDocument());
    expect(screen.getAllByText("Sent").length).toBeGreaterThan(0);
  });

  it("shows empty state when no history", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ segments: [], counts: {}, history: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no broadcasts/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<BroadcastPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
