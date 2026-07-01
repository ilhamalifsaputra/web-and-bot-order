import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaymentsPage } from "./PaymentsPage";
import { apiGet, apiPost } from "../api/client";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const TX = { id: 1, binanceTxId: "TX123", amount: "100000", currency: "IDR", outcome: "MATCHED", memo: "ORDER-001", processedAt: "2026-06-26T10:00:00.000Z" };

function mockPaymentsFetch(payload: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
  // Radix Dialog/Select use pointer-capture APIs and scrollIntoView — jsdom
  // doesn't implement them.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("PaymentsPage", () => {
  it("renders transaction rows", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [TX], total: 1, page: 1, hasNext: false, outcomes: ["MATCHED", "UNMATCHED"], counts: { MATCHED: 1 } });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX123")).toBeInTheDocument());
    expect(screen.getByText("MATCHED")).toBeInTheDocument();
  });

  it("shows empty state", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("computes today's total / pending / failed stat cards from the fetched ledger", async () => {
    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const ledger = [
      { id: 1, binanceTxId: "TX1", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: today },
      { id: 2, binanceTxId: "TX2", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: today },
      { id: 3, binanceTxId: "TX3", amount: "1", currency: "IDR", outcome: "delivery_failed", memo: null, processedAt: yesterday },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 3, page: 1, hasNext: false, outcomes: ["matched", "unmatched", "delivery_failed"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX1")).toBeInTheDocument());

    const todayCard = screen.getByText("Today's Transactions").closest('[data-slot="card"]') as HTMLElement;
    expect(within(todayCard).getByText("2")).toBeInTheDocument(); // TX1 + TX2 processed today

    const pendingCard = screen.getByText("Pending").closest('[data-slot="card"]') as HTMLElement;
    expect(within(pendingCard).getByText("1")).toBeInTheDocument(); // TX2 (unmatched)

    const failedCard = screen.getByText("Failed").closest('[data-slot="card"]') as HTMLElement;
    expect(within(failedCard).getByText("1")).toBeInTheDocument(); // TX3 (delivery_failed)
  });

  it("debounces order-code lookups via /api/search and fills the input on selecting a suggestion", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {} });
    vi.mocked(apiGet).mockResolvedValue({ q: "abc-1", exactOrderId: 42 });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());

    const orderInput = screen.getByPlaceholderText("Order code");
    fireEvent.focus(orderInput);
    fireEvent.change(orderInput, { target: { value: "abc-1" } });

    // Not called immediately — debounced.
    expect(apiGet).not.toHaveBeenCalled();

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/search?q=abc-1"));
    const suggestion = await screen.findByText("ABC-1");

    fireEvent.click(suggestion);
    expect((orderInput as HTMLInputElement).value).toBe("ABC-1");
  });

  it("shows a 'no matching order code' hint when /api/search finds nothing", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {} });
    vi.mocked(apiGet).mockResolvedValue({ q: "zzz", exactOrderId: null });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());

    const orderInput = screen.getByPlaceholderText("Order code");
    fireEvent.focus(orderInput);
    fireEvent.change(orderInput, { target: { value: "zzz" } });

    await waitFor(() => expect(screen.getByText(/no matching order code/i)).toBeInTheDocument());
  });

  it("requires confirmation via ConfirmDialog before submitting a manual match", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {} });
    vi.mocked(apiPost).mockResolvedValue({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("Transfer ID"), { target: { value: "TX999" } });
    fireEvent.change(screen.getByPlaceholderText("Order code"), { target: { value: "ORDER-9" } });

    fireEvent.click(screen.getByRole("button", { name: "Match" }));
    expect(apiPost).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/TX999/)).toBeInTheDocument();
    expect(within(dialog).getByText(/ORDER-9/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Match" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/payments/match", { binance_tx_id: "TX999", order_code: "ORDER-9" }),
    );
  });

  it("disables the Match trigger until both fields are filled", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Match" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Transfer ID"), { target: { value: "TX999" } });
    expect(screen.getByRole("button", { name: "Match" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Order code"), { target: { value: "ORDER-9" } });
    expect(screen.getByRole("button", { name: "Match" })).not.toBeDisabled();
  });
});
