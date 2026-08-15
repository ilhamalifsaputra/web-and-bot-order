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

function WrapperAt({ initialEntries, children }: { initialEntries: string[]; children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={qc}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const TX = { id: 1, gateway: "binance", reference: "TX123", amount: "100000", currency: "IDR", outcome: "MATCHED", memo: "ORDER-001", processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" };

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

  it("truncates a long Transfer ID with a bounded width, keeping the full value in title (Task 4)", async () => {
    const longRef = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a4392817065e4d3c2b1a0";
    mockPaymentsFetch({
      enabled: true,
      ledger: [{ ...TX, reference: longRef }],
      total: 1,
      page: 1,
      hasNext: false,
      outcomes: ["MATCHED"],
      counts: { MATCHED: 1 },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });

    const refEl = await screen.findByTitle(longRef);
    expect(refEl).toHaveClass("truncate");
    expect(refEl.className).toMatch(/max-w-\[200px\]/);
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("shows today's total / pending / failed stat cards from server-provided fields", async () => {
    const ledger = [
      { id: 1, gateway: "binance", reference: "TX1", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-26T10:00:00.000Z" },
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
      { id: 99, gateway: "binance", reference: "PAGE2-TX", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-01T10:00:00.000Z" },
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

  it("truncates a long order-code suggestion inside the bounded autocomplete dropdown, keeping the full code in title (Task 4)", async () => {
    const longCode = "ABC-VERY-LONG-ORDER-CODE-1234567890";
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {} });
    vi.mocked(apiGet).mockResolvedValue({ q: longCode, exactOrderId: 42 });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());

    const orderInput = screen.getByPlaceholderText("Order code");
    fireEvent.focus(orderInput);
    fireEvent.change(orderInput, { target: { value: longCode } });

    const suggestionEl = await screen.findByTitle(longCode);
    expect(suggestionEl).toHaveClass("truncate");
    expect(suggestionEl).toHaveTextContent(longCode);
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
    const user = userEvent.setup();
    const ledger = [
      { id: 1, gateway: "binance", reference: "TX1", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 1, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for transfer TX1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Dismiss"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/TX1/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "TX1" }));
  });

  it("does not show an actions menu for a matched transfer", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [TX], total: 1, todayCount: 0, page: 1, hasNext: false, outcomes: ["MATCHED", "UNMATCHED"], counts: { MATCHED: 1 } });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX123")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /actions for transfer/i })).not.toBeInTheDocument();
  });

  it("adds an unmatched transfer's amount to the buyer's credit balance via order code", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 1, gateway: "binance", reference: "CREDIT1", amount: "5", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 1, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    // Search resolves case-insensitively and reports the canonical (uppercased)
    // code — the admin types lowercase, the API's fallback still finds it.
    vi.mocked(apiGet).mockResolvedValue({ q: "order-9", exactOrderId: 9 });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CREDIT1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for transfer CREDIT1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Add to buyer's credit balance"));

    const dialog = await screen.findByRole("dialog");
    const orderInput = within(dialog).getByPlaceholderText("Order code");
    fireEvent.change(orderInput, { target: { value: "order-9" } });

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Add to credit balance" })).not.toBeDisabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to credit balance" }));

    // Must submit the canonical uppercased code from the suggestion, not the
    // raw lowercase text the admin typed — the backend's lookup is
    // case-sensitive and would 404 on "order-9".
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/payments/credit", { binance_tx_id: "CREDIT1", order_code: "ORDER-9" }),
    );
  });

  // The server computes the verdict via evaluatePollHealth (packages/core/src/
  // payments/pollHealth.ts) and ships it as status/detail/staleMs alongside
  // the raw heartbeat — the client only renders it, it does not re-derive a
  // pill from consecutiveFailures/lastRun/backoffUntil itself.
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
      health: {
        lastRun: "2026-07-24T09:00:00.000Z",
        lastSuccessAt: null,
        lastTxCount: null,
        backoffUntil: null,
        consecutiveRateLimitHits: null,
        lastRateLimitAt: null,
        consecutiveFailures: 4,
        lastError: "timeout",
        status: "red",
        detail: "Cycles are completing but 4 consecutive cycles failed (last error: timeout).",
        staleMs: 60_000,
      },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());
    const pill = screen.getByText(/4 consecutive cycles failed/i);
    expect(pill).toBeInTheDocument();
    expect(pill.closest("div")!.querySelector(".bg-rust")).not.toBeNull();
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
      health: {
        lastRun: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        lastTxCount: 3,
        backoffUntil: null,
        consecutiveRateLimitHits: null,
        lastRateLimitAt: null,
        consecutiveFailures: 0,
        lastError: null,
        status: "green",
        detail: "Cycles are completing normally; last run 0 minute(s) ago.",
        staleMs: 0,
      },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());
    const pill = screen.getByText(/cycles are completing normally/i);
    expect(pill).toBeInTheDocument();
    expect(pill.closest("div")!.querySelector(".bg-grass")).not.toBeNull();
  });

  // RED test for this task: today the client derives its own pill from
  // consecutiveFailures/lastRun (healthPill in PaymentsPage.tsx), so a poller
  // whose lastRun keeps advancing on failed cycles but hasn't had a
  // *successful* cycle in hours still reads "Synced 2h ago" at level "ok" as
  // long as consecutiveFailures happens to be 0 (e.g. the failures were rate
  // limits, tracked separately). The server's evaluatePollHealth rule catches
  // this via staleness against lastRun regardless of consecutiveFailures —
  // the client must render that verdict (status/detail), not recompute one.
  it("shows a critical pill for a poller that has not completed a cycle in hours", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    mockPaymentsFetch({
      enabled: true,
      ledger: [],
      total: 0,
      todayCount: 0,
      page: 1,
      hasNext: false,
      outcomes: [],
      counts: {},
      health: {
        lastRun: twoHoursAgo,
        lastSuccessAt: twoHoursAgo,
        lastTxCount: null,
        backoffUntil: null,
        consecutiveRateLimitHits: null,
        lastRateLimitAt: null,
        consecutiveFailures: 0,
        lastError: null,
        status: "red",
        detail: "No cycle has completed in 120 minute(s); the poller appears stuck or stopped.",
        staleMs: 2 * 60 * 60 * 1000,
      },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());

    const pill = screen.getByText(/poller appears stuck or stopped/i);
    expect(pill).toBeInTheDocument();
    expect(pill.closest("div")!.querySelector(".bg-rust")).not.toBeNull();
    expect(screen.queryByText(/synced/i)).not.toBeInTheDocument();
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
      health: {
        lastRun: null,
        lastSuccessAt: null,
        lastTxCount: null,
        backoffUntil: null,
        consecutiveRateLimitHits: null,
        lastRateLimitAt: null,
        consecutiveFailures: null,
        lastError: null,
        status: "unmonitored",
        detail: "Health monitoring is disabled for this poller.",
        staleMs: null,
      },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());
    expect(screen.queryByText(/synced|consecutive|not yet synced|retrying|disabled for this poller/i)).not.toBeInTheDocument();
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
      { id: 1, gateway: "binance", reference: "BULK1", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 2, gateway: "binance", reference: "BULK2", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 3, gateway: "binance", reference: "MATCHED1", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
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
      { id: 1, gateway: "binance", reference: "ELIG1", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 2, gateway: "binance", reference: "MATCHED2", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 2, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched", "matched"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ELIG1")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select all eligible transfers/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  // Only unmatched Binance transfers get a checkbox, so a transfer the
  // reconciler matches between refetches must drop out of the count — otherwise
  // Dismiss would carry an id whose row no longer offers a checkbox at all.
  it("stops counting a selected transfer once it is no longer eligible", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function LocalWrapper({ children }: { children: React.ReactNode }) {
      return (
        <MemoryRouter>
          <QueryClientProvider client={qc}>
            {children}
            <Toaster />
          </QueryClientProvider>
        </MemoryRouter>
      );
    }
    const stays = { id: 1, gateway: "binance", reference: "STAYS", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" };
    const getsMatched = { ...stays, id: 2, reference: "GETSMATCHED" };
    const base = { enabled: true, total: 2, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched", "matched"], counts: {} };

    mockPaymentsFetch({ ...base, ledger: [stays, getsMatched] });
    render(<PaymentsPage />, { wrapper: LocalWrapper });
    await waitFor(() => expect(screen.getByText("STAYS")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select all eligible transfers/i }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    mockPaymentsFetch({ ...base, ledger: [stays, { ...getsMatched, outcome: "matched" }] });
    await qc.invalidateQueries({ queryKey: ["payments"] });

    await waitFor(() => expect(screen.getByText("1 selected")).toBeInTheDocument());

    // And the payload follows the count: the matched transfer must not be
    // dismissed just because it was selected while it was still eligible.
    vi.mocked(apiPost).mockResolvedValue({ ok: true });
    mockPaymentsFetch({ ...base, ledger: [stays, { ...getsMatched, outcome: "matched" }] });
    await user.click(screen.getByRole("button", { name: /dismiss 1 transfer/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "STAYS" }),
    );
    expect(apiPost).not.toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "GETSMATCHED" });
  });

  it("clears the bulk selection when navigating to the next page", async () => {
    const user = userEvent.setup();
    const pageOneLedger = [
      { id: 1, gateway: "binance", reference: "PAGE1-TX", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger: pageOneLedger, total: 51, todayCount: 0, page: 1, hasNext: true, outcomes: ["unmatched"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("PAGE1-TX")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select transfer page1-tx/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    const pageTwoLedger = [
      { id: 2, gateway: "binance", reference: "PAGE2-TX", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger: pageTwoLedger, total: 51, todayCount: 0, page: 2, hasNext: false, outcomes: ["unmatched"], counts: {} });
    await user.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => expect(screen.getByText("PAGE2-TX")).toBeInTheDocument());
    expect(screen.queryByText(/\d+ selected/)).not.toBeInTheDocument();
  });

  it("shows result-count text and moves to the next page via the shared Pagination control", async () => {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [TX], total: 120, todayCount: 0, page: 1, hasNext: true, outcomes: ["MATCHED"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX123")).toBeInTheDocument());

    expect(screen.getByText(/showing 1–50 of 120/i)).toBeInTheDocument();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, ledger: [], total: 120, todayCount: 0, page: 2, hasNext: true, outcomes: [], counts: {} }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("page=2")));
  });

  // Task 47 (backend audit follow-up): PaymentsPage used to always start
  // outcome="" regardless of the URL, so landing here via the Operation
  // Center's "Failed Deliveries" card (/payments?outcome=delivery_failed)
  // showed an unfiltered ledger. Pre-fix, this test's fetch would have been
  // called without an outcome param at all.
  it("seeds the outcome filter from ?outcome= in the URL on mount", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: ["delivery_failed"], counts: {} }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(
      <WrapperAt initialEntries={["/payments?outcome=delivery_failed"]}>
        <PaymentsPage />
      </WrapperAt>,
    );
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("outcome=delivery_failed")),
    );
  });

  it("renders a gateway column and omits the row-action dropdown for a non-Binance row, even when unmatched", async () => {
    const ledger = [
      { id: 1, gateway: "binance", reference: "BN-1", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 2, gateway: "tokopay", reference: "TP-1", amount: "50000", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 2, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("BN-1")).toBeInTheDocument());

    expect(screen.getByText("TP-1")).toBeInTheDocument();
    expect(screen.getByText("TokoPay")).toBeInTheDocument();
    expect(screen.getByText("Binance Internal")).toBeInTheDocument();

    // Binance's unmatched row gets the actions dropdown; TokoPay's doesn't,
    // even though it's also unmatched (manual match/credit/dismiss are
    // Binance-only on the backend).
    expect(screen.getByRole("button", { name: "Actions for transfer BN-1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions for transfer TP-1" })).not.toBeInTheDocument();
  });

  // T5: a wallet top-up's payment was indistinguishable from a product sale
  // here — the ledger row carried only a numeric orderId.
  it("shows each row's order code and marks wallet top-ups apart from product sales", async () => {
    const ledger = [
      { id: 1, gateway: "tokopay", reference: "TP-SALE", amount: "50000", currency: "IDR", outcome: "matched", memo: null, orderId: 11, orderCode: "ORD-SALE", orderKind: "PRODUCT", processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 2, gateway: "tokopay", reference: "TP-TOPUP", amount: "100000", currency: "IDR", outcome: "matched", memo: null, orderId: 12, orderCode: "ORD-TOPUP", orderKind: "WALLET_TOPUP", processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 3, gateway: "binance", reference: "BN-ORPHAN", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, orderId: null, orderCode: null, orderKind: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 3, todayCount: 0, page: 1, hasNext: false, outcomes: ["matched"], kinds: ["PRODUCT", "WALLET_TOPUP"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TP-SALE")).toBeInTheDocument());

    expect(screen.getByText("ORD-SALE")).toBeInTheDocument();
    expect(screen.getByText("ORD-TOPUP")).toBeInTheDocument();
    expect(screen.getByText("Wallet Topup")).toBeInTheDocument();
    expect(screen.getByText("Product")).toBeInTheDocument();
  });

  it("seeds the order-type filter from ?kind= in the URL on mount", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: [], kinds: ["PRODUCT", "WALLET_TOPUP"], counts: {} }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(
      <WrapperAt initialEntries={["/payments?kind=WALLET_TOPUP"]}>
        <PaymentsPage />
      </WrapperAt>,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("kind=WALLET_TOPUP")));
  });

  it("re-queries from page 1 when the order-type filter changes", async () => {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 3, hasNext: false, outcomes: [], kinds: ["PRODUCT", "WALLET_TOPUP"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: [], kinds: ["PRODUCT", "WALLET_TOPUP"], counts: {} }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await user.click(screen.getByRole("combobox", { name: /order type/i }));
    await user.click(await screen.findByRole("option", { name: "Wallet Topup" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("kind=WALLET_TOPUP")));
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("page=1"));
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

  it("truncates a long buyer name in the Underpaid Orders table, keeping the full name in title (Task 4)", async () => {
    const longName = "Muhammad Alexander Wijayakusuma Setiawan Prabowo Nugroho";
    mockPaymentsFetch({
      enabled: true,
      ledger: [],
      total: 0,
      page: 1,
      hasNext: false,
      outcomes: [],
      counts: {},
      underpaid: [{ ...UNDERPAID, user: { fullName: longName, username: "muhammad" } }],
      pendingInternal: [],
    });
    render(<PaymentsPage />, { wrapper: Wrapper });

    const nameEl = await screen.findByTitle(longName);
    expect(nameEl).toHaveClass("truncate");
    expect(nameEl.closest(".flex")?.className).toMatch(/max-w-\[200px\]/);
  });

  it("truncates a long Transfer Ref in the Pending Internal Transfers table, keeping the full value in title (Task 4)", async () => {
    const longRef = "REF-0x9f8e7d6c5b4a3928170665e4d3c2b1a0-internal-transfer";
    mockPaymentsFetch({
      enabled: true,
      ledger: [],
      total: 0,
      page: 1,
      hasNext: false,
      outcomes: [],
      counts: {},
      underpaid: [],
      pendingInternal: [{ ...PENDING_INTERNAL, paymentRef: longRef }],
    });
    render(<PaymentsPage />, { wrapper: Wrapper });

    const refEl = await screen.findByTitle(longRef);
    expect(refEl).toHaveClass("truncate");
    expect(refEl.className).toMatch(/max-w-\[200px\]/);
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
