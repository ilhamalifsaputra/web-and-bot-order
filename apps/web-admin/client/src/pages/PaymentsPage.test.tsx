import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaymentsPage } from "./PaymentsPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const TX = { id: 1, binanceTxId: "TX123", amount: "100000", currency: "IDR", outcome: "MATCHED", memo: "ORDER-001", processedAt: "2026-06-26T10:00:00.000Z" };

beforeEach(() => { vi.restoreAllMocks(); });

describe("PaymentsPage", () => {
  it("renders transaction rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ enabled: true, ledger: [TX], total: 1, page: 1, hasNext: false, outcomes: ["MATCHED", "UNMATCHED"], counts: { MATCHED: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX123")).toBeInTheDocument());
    expect(screen.getByText("MATCHED")).toBeInTheDocument();
  });

  it("shows empty state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {} }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
