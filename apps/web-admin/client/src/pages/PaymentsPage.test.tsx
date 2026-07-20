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

const TX = { id: 1, binanceTxId: "TX123", amount: "100000", currency: "IDR", outcome: "MATCHED", memo: "ORDER-001", processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" };

function mockPaymentsFetch(payload: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
  // Safe default so the 300ms order-code-suggest debounce (PaymentsPage.tsx's
  // useOrderCodeSuggest) never calls `.then` on `undefined`: several tests
  // type into the "Order code" field without caring about the suggestion
  // feature and never give apiGet its own mock. Under a slow/loaded test run
  // the debounce can fire before the component unmounts, and a bare vi.fn()
  // resolves to undefined — an uncaught exception outside any assertion.
  // Tests that DO care about the suggestion override this with their own
  // mockResolvedValue/mockImplementation.
  vi.mocked(apiGet).mockResolvedValue({ q: "", exactOrderId: null });
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
    expect(screen.getByText("Matched")).toBeInTheDocument();
    expect(screen.getByText("2026-06-26 17:00")).toBeInTheDocument(); // processedAtDisplay
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

  it("shows a Dismiss action for an unmatched transfer and dismisses it after confirming", async () => {
    const ledger = [
      { id: 1, binanceTxId: "TX1", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 1, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/TX1/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "TX1" }));
  });

  it("does not show a Dismiss action for a matched transfer", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [TX], total: 1, page: 1, hasNext: false, outcomes: ["MATCHED", "UNMATCHED"], counts: { MATCHED: 1 } });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX123")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });
});

const UNDERPAID = {
  id: 501,
  orderCode: "ORD-UP1",
  totalAmount: "45000",
  currency: "IDR",
  createdAt: "2026-06-20T08:00:00.000Z",
  createdAtDisplay: "2026-06-20 15:00",
  user: { fullName: "Sari Dewi", username: "saridewi" },
};
const PENDING_INTERNAL = {
  id: 502,
  orderCode: "ORD-PI1",
  totalAmount: "3",
  currency: "USDT",
  paymentRef: "REF-abc123",
  expiresAt: "2026-07-01T12:00:00.000Z",
  expiresAtDisplay: "2026-07-01 19:00",
  user: { fullName: "Budi", username: "budi99" },
};

describe("PaymentsPage — underpaid order resolution", () => {
  it("lists underpaid orders and delivers one anyway", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Deliver anyway" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deliver anyway" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/deliver", {}));
  });

  it("refunds an underpaid order to the buyer's wallet", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Refund" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/refund", {}));
  });

  it("cancels an underpaid order", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel order" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/cancel", {}));
  });

  it("lists pending internal transfers awaiting confirmation", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [], pendingInternal: [PENDING_INTERNAL] });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-PI1")).toBeInTheDocument());
    expect(screen.getByText("REF-abc123")).toBeInTheDocument();
    expect(screen.getByText("2026-07-01 19:00")).toBeInTheDocument(); // expiresAtDisplay
  });

  it("shows an alert when resolving an underpaid order fails", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockRejectedValueOnce(new Error("Order is no longer underpaid."));
    const alertSpy = vi.spyOn(globalThis, "alert").mockImplementation(() => {});
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Deliver anyway" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deliver anyway" }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Order is no longer underpaid."));
  });
});
