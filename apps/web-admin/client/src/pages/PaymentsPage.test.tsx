import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
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
      <QueryClientProvider client={qc}>
        {children}
        <Toaster />
      </QueryClientProvider>
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

  it("shows today's total / pending / failed stat cards from server-provided fields", async () => {
    const ledger = [
      { id: 1, binanceTxId: "TX1", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-26T10:00:00.000Z" },
    ];
    mockPaymentsFetch({
      enabled: true,
      ledger,
      total: 1,
      todayCount: 7,
      page: 1,
      hasNext: false,
      outcomes: ["matched", "unmatched", "delivery_failed"],
      counts: { unmatched: 3, delivery_failed: 2 },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX1")).toBeInTheDocument());

    const todayCard = screen.getByText("Today's Transactions").closest('[data-slot="card"]') as HTMLElement;
    expect(within(todayCard).getByText("7")).toBeInTheDocument();

    const pendingCard = screen.getByText("Pending").closest('[data-slot="card"]') as HTMLElement;
    expect(within(pendingCard).getByText("3")).toBeInTheDocument();

    const failedCard = screen.getByText("Failed").closest('[data-slot="card"]') as HTMLElement;
    expect(within(failedCard).getByText("2")).toBeInTheDocument();
  });

  it("shows a page-2 KPI value that differs from what the current page alone would suggest", async () => {
    // Regression guard for the bug this task fixes: with the old client-side
    // computation, a KPI on page 2 could only ever reflect page 2's rows.
    const ledger = [
      { id: 99, binanceTxId: "PAGE2-TX", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-01T10:00:00.000Z" },
    ];
    mockPaymentsFetch({
      enabled: true,
      ledger,
      total: 60,
      todayCount: 12,
      page: 2,
      hasNext: false,
      outcomes: ["matched"],
      counts: { unmatched: 5 },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("PAGE2-TX")).toBeInTheDocument());

    const todayCard = screen.getByText("Today's Transactions").closest('[data-slot="card"]') as HTMLElement;
    expect(within(todayCard).getByText("12")).toBeInTheDocument(); // not 0, not derived from the 1 row on this page
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

  it("shows a health pill with consecutive failures when the poller is unhealthy", async () => {
    mockPaymentsFetch({
      enabled: true,
      ledger: [],
      total: 0,
      todayCount: 0,
      page: 1,
      hasNext: false,
      outcomes: [],
      counts: {},
      health: { lastRun: "2026-07-24T09:00:00.000Z", lastSuccessAt: null, lastTxCount: null, backoffUntil: null, consecutiveRateLimitHits: null, lastRateLimitAt: null, consecutiveFailures: 4, lastError: "timeout" },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());
    expect(screen.getByText(/4 consecutive failures/i)).toBeInTheDocument();
  });

  it("shows a synced-recently health pill on a healthy poller", async () => {
    mockPaymentsFetch({
      enabled: true,
      ledger: [],
      total: 0,
      todayCount: 0,
      page: 1,
      hasNext: false,
      outcomes: [],
      counts: {},
      health: { lastRun: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastTxCount: 3, backoffUntil: null, consecutiveRateLimitHits: null, lastRateLimitAt: null, consecutiveFailures: 0, lastError: null },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());
    expect(screen.getByText(/synced/i)).toBeInTheDocument();
  });

  it("shows no health pill when Binance internal is disabled", async () => {
    mockPaymentsFetch({
      enabled: false,
      ledger: [],
      total: 0,
      todayCount: 0,
      page: 1,
      hasNext: false,
      outcomes: [],
      counts: {},
      health: { lastRun: null, lastSuccessAt: null, lastTxCount: null, backoffUntil: null, consecutiveRateLimitHits: null, lastRateLimitAt: null, consecutiveFailures: null, lastError: null },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());
    expect(screen.queryByText(/synced|consecutive failures|not yet synced|retrying/i)).not.toBeInTheDocument();
  });

  it("debounces Ledger search into the query params", async () => {
    vi.useFakeTimers();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: [], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await vi.waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: [], counts: {} }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const search = screen.getByPlaceholderText(/search transfer id/i);
    fireEvent.change(search, { target: { value: "ABC" } });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("q=ABC")));
    vi.useRealTimers();
  });

  it("bulk-dismisses selected unmatched transfers", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 1, binanceTxId: "BULK1", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 2, binanceTxId: "BULK2", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 3, binanceTxId: "MATCHED1", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 3, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched", "matched"], counts: {} });
    vi.mocked(apiPost).mockResolvedValue({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("BULK1")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select transfer bulk1/i }));
    await user.click(screen.getByRole("checkbox", { name: /select transfer bulk2/i }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /dismiss 2 transfers/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "BULK1" });
      expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "BULK2" });
    });
  });

  it("only offers a select-all checkbox that selects eligible (unmatched) rows", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 1, binanceTxId: "ELIG1", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 2, binanceTxId: "MATCHED2", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 2, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched", "matched"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ELIG1")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select all eligible transfers/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("clears the bulk selection when navigating to the next page", async () => {
    const user = userEvent.setup();
    const pageOneLedger = [
      { id: 1, binanceTxId: "PAGE1-TX", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger: pageOneLedger, total: 2, todayCount: 0, page: 1, hasNext: true, outcomes: ["unmatched"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("PAGE1-TX")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select transfer page1-tx/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    const pageTwoLedger = [
      { id: 2, binanceTxId: "PAGE2-TX", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger: pageTwoLedger, total: 2, todayCount: 0, page: 2, hasNext: false, outcomes: ["unmatched"], counts: {} });
    await user.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => expect(screen.getByText("PAGE2-TX")).toBeInTheDocument());
    expect(screen.queryByText(/\d+ selected/)).not.toBeInTheDocument();
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
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for order ORD-UP1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Deliver anyway"));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deliver anyway" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/deliver", {}));
  });

  it("refunds an underpaid order to the buyer's wallet", async () => {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for order ORD-UP1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Refund"));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Refund" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/refund", {}));
  });

  it("cancels an underpaid order", async () => {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for order ORD-UP1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Cancel order"));

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

  it("shows a toast when resolving an underpaid order fails", async () => {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockRejectedValueOnce(new Error("Order is no longer underpaid."));
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for order ORD-UP1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Deliver anyway"));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deliver anyway" }));

    expect(await screen.findByText("Order is no longer underpaid.")).toBeInTheDocument();
  });
});
