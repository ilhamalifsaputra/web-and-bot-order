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

// Task 2 (fetch → shared Application Client): PaymentsPage's own usePayments
// now calls apiGet(`/api/payments?...`) instead of raw fetch(), so the ledger
// payload has to be served by the same mocked apiGet the order-code-suggest
// calls (`/api/search?...`) already go through — a single mock function
// serving two different endpoints, dispatched by path prefix. These two
// mutable payloads are what that dispatcher reads; mockPaymentsFetch (below)
// and the search-suggestion overrides just reassign them, so a mid-test
// reassignment (e.g. simulating a refetch after invalidateQueries) is picked
// up on the next apiGet call with no extra mock plumbing.
let paymentsPayload: Record<string, unknown> = { enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {} };
let searchPayload: { q: string; exactOrderId: number | null } = { q: "", exactOrderId: null };

function mockPaymentsFetch(payload: Record<string, unknown>) {
  paymentsPayload = payload;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
  paymentsPayload = { enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {} };
  // Safe default so the 300ms order-code-suggest debounce (PaymentsPage.tsx's
  // useOrderCodeSuggest) never calls `.then` on `undefined`: several tests
  // type into the "Order code" field without caring about the suggestion
  // feature and never give the search path its own payload. Under a slow/
  // loaded test run the debounce can fire before the component unmounts, and
  // a bare vi.fn() resolves to undefined — an uncaught exception outside any
  // assertion. Tests that DO care about the suggestion override
  // `searchPayload` directly.
  searchPayload = { q: "", exactOrderId: null };
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path.startsWith("/api/payments") ? paymentsPayload : searchPayload,
  );
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
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path.startsWith("/api/payments")) throw new Error("network");
      return searchPayload;
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("shows today's total / unmatched / failed-deliveries stat cards from server-provided fields", async () => {
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

    // The tile counts `unmatched` ledger rows (transfers waiting for an admin
    // to match them), not "pending" anything, so it says so.
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
    const unmatchedCard = screen.getByText("Unmatched").closest('[data-slot="card"]') as HTMLElement;
    expect(within(unmatchedCard).getByText("3")).toBeInTheDocument();

    // Named after the dashboard card that links here, since both count
    // `delivery_failed` rows across every gateway.
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    const failedCard = screen.getByText("Failed Deliveries").closest('[data-slot="card"]') as HTMLElement;
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
    searchPayload = { q: "abc-1", exactOrderId: 42 };
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());

    // Isolate the debounced search call's own args from the mount-time
    // /api/payments call already recorded on this same mocked apiGet.
    vi.mocked(apiGet).mockClear();

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
    searchPayload = { q: longCode, exactOrderId: 42 };
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
    searchPayload = { q: "zzz", exactOrderId: null };
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
      expect(apiPost).toHaveBeenCalledWith("/api/payments/match", { binance_tx_id: "TX999", order_code: "ORDER-9" }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
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

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "TX1", gateway: "binance" }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
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
    searchPayload = { q: "order-9", exactOrderId: 9 };
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
      expect(apiPost).toHaveBeenCalledWith("/api/payments/credit", { binance_tx_id: "CREDIT1", order_code: "ORDER-9" }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
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

    // Isolate the debounced call's own args from the mount-time call already
    // recorded above.
    vi.mocked(apiGet).mockClear();

    const search = screen.getByPlaceholderText(/search transfer id/i);
    fireEvent.change(search, { target: { value: "ABC" } });
    expect(apiGet).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining("q=ABC")));
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
      expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "BULK1", gateway: "binance" }, expect.objectContaining({ idempotencyKey: expect.any(String) }));
      expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "BULK2", gateway: "binance" }, expect.objectContaining({ idempotencyKey: expect.any(String) }));
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

  // Only unmatched transfers get a checkbox, so a transfer the
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
      expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "STAYS", gateway: "binance" }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
    );
    expect(apiPost).not.toHaveBeenCalledWith("/api/payments/dismiss", expect.objectContaining({ binance_tx_id: "GETSMATCHED" }), expect.anything());
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

    mockPaymentsFetch({ enabled: true, ledger: [], total: 120, todayCount: 0, page: 2, hasNext: true, outcomes: [], counts: {} });
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining("page=2")));
  });

  // Task 47 (backend audit follow-up): PaymentsPage used to always start
  // outcome="" regardless of the URL, so landing here via the Operation
  // Center's "Failed Deliveries" card (/payments?outcome=delivery_failed)
  // showed an unfiltered ledger. Pre-fix, this test's fetch would have been
  // called without an outcome param at all.
  it("seeds the outcome filter from ?outcome= in the URL on mount", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: ["delivery_failed"], counts: {} });
    render(
      <WrapperAt initialEntries={["/payments?outcome=delivery_failed"]}>
        <PaymentsPage />
      </WrapperAt>,
    );
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining("outcome=delivery_failed")),
    );
  });

  it("forwards ?actionable=1 to the ledger request and shows a note that clears it", async () => {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: ["delivery_failed"], counts: {} });
    render(
      <WrapperAt initialEntries={["/payments?outcome=delivery_failed&actionable=1"]}>
        <PaymentsPage />
      </WrapperAt>,
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining("actionable=1")));
    expect(screen.getByText(/showing only items still needing action/i)).toBeInTheDocument();

    vi.mocked(apiGet).mockClear();
    await user.click(screen.getByRole("button", { name: /show all/i }));
    await waitFor(() => expect(screen.queryByText(/showing only items still needing action/i)).not.toBeInTheDocument());
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(vi.mocked(apiGet).mock.calls.some(([p]) => String(p).startsWith("/api/payments") && !String(p).includes("actionable"))).toBe(true);
  });

  // The server ignores `actionable` for any outcome but unmatched /
  // delivery_failed, so keeping the flag (and its note) after switching to
  // another outcome would claim a filter that is not being applied.
  it("drops ?actionable=1 when the outcome changes to one the flag does not apply to", async () => {
    const user = userEvent.setup();
    const payload = { enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: ["matched", "unmatched", "delivery_failed"], counts: {} };
    mockPaymentsFetch(payload);
    render(
      <WrapperAt initialEntries={["/payments?outcome=delivery_failed&actionable=1"]}>
        <PaymentsPage />
      </WrapperAt>,
    );
    await waitFor(() => expect(screen.getByText(/showing only items still needing action/i)).toBeInTheDocument());

    // Switching between the two actionable outcomes keeps the flag.
    await user.click(screen.getByRole("combobox", { name: /outcome/i }));
    await user.click(await screen.findByRole("option", { name: /^unmatched/ }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringMatching(/outcome=unmatched.*actionable=1|actionable=1.*outcome=unmatched/)));
    expect(screen.getByText(/showing only items still needing action/i)).toBeInTheDocument();

    vi.mocked(apiGet).mockClear();
    mockPaymentsFetch(payload);
    await user.click(screen.getByRole("combobox", { name: /outcome/i }));
    await user.click(await screen.findByRole("option", { name: /^matched/ }));
    await waitFor(() => expect(screen.queryByText(/showing only items still needing action/i)).not.toBeInTheDocument());
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining("outcome=matched")));
    expect(vi.mocked(apiGet).mock.calls.map(([p]) => String(p)).filter((p) => p.includes("actionable"))).toEqual([]);
  });

  it("does not send actionable when the URL flag is absent", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: [], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(vi.mocked(apiGet).mock.calls.every(([p]) => !String(p).includes("actionable"))).toBe(true);
    expect(screen.queryByText(/showing only items still needing action/i)).not.toBeInTheDocument();
  });

  it("renders a gateway column and offers match + dismiss (but not credit) on an unmatched non-Binance row", async () => {
    const user = userEvent.setup();
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

    // Every gateway's unmatched row is selectable for bulk dismiss.
    expect(screen.getByRole("checkbox", { name: "Select transfer TP-1" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions for transfer TP-1" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Match to order…")).toBeInTheDocument();
    expect(within(menu).getByText("Dismiss")).toBeInTheDocument();
    // Credit-to-balance stays Binance-only on the backend.
    expect(within(menu).queryByText("Add to buyer's credit balance")).not.toBeInTheDocument();
  });

  it("keeps the credit item on a Binance row's menu beside Match to order…", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 1, gateway: "binance", reference: "BN-1", amount: "1", currency: "USDT", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 1, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("BN-1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for transfer BN-1" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Match to order…")).toBeInTheDocument();
    expect(within(menu).getByText("Add to buyer's credit balance")).toBeInTheDocument();
    expect(within(menu).getByText("Dismiss")).toBeInTheDocument();
  });

  it("pre-fills the Manual Match form from a Bybit row's menu and sends the gateway with the match", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 7, gateway: "bybit", reference: "BY-77", amount: "10", currency: "USDT", outcome: "unmatched", memo: null, orderId: null, orderCode: null, orderKind: null, orderStatus: null, suggestedOrderId: 31, suggestedOrderCode: "ORD-SUGG", suggestedOrderKind: "PRODUCT", processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 1, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    vi.mocked(apiPost).mockResolvedValue({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("BY-77")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for transfer BY-77" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Match to order…"));

    expect(screen.getByPlaceholderText("Transfer ID")).toHaveValue("BY-77");
    expect(screen.getByPlaceholderText("Order code")).toHaveValue("ORD-SUGG");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Match" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Match" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        "/api/payments/match",
        { binance_tx_id: "BY-77", order_code: "ORD-SUGG", gateway: "bybit" },
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      ),
    );
    expect(await screen.findByText("Transfer matched to order ORD-SUGG.")).toBeInTheDocument();
  });

  it("leaves the order code empty when the row has no suggestion, and drops the gateway once the Transfer ID is edited by hand", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 8, gateway: "paydisini", reference: "PD-8", amount: "50000", currency: "IDR", outcome: "unmatched", memo: null, orderId: null, orderCode: null, orderKind: null, orderStatus: null, suggestedOrderId: null, suggestedOrderCode: null, suggestedOrderKind: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 1, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    vi.mocked(apiPost).mockResolvedValue({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("PD-8")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for transfer PD-8" }));
    await user.click(within(await screen.findByRole("menu")).getByText("Match to order…"));
    expect(screen.getByPlaceholderText("Transfer ID")).toHaveValue("PD-8");
    expect(screen.getByPlaceholderText("Order code")).toHaveValue("");

    fireEvent.change(screen.getByPlaceholderText("Transfer ID"), { target: { value: "OTHER-REF" } });
    fireEvent.change(screen.getByPlaceholderText("Order code"), { target: { value: "ORD-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Match" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Match" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        "/api/payments/match",
        { binance_tx_id: "OTHER-REF", order_code: "ORD-1" },
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      ),
    );
  });

  it("dismisses a TokoPay row with its gateway in the request", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 2, gateway: "tokopay", reference: "TP-1", amount: "50000", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 1, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    vi.mocked(apiPost).mockResolvedValue({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TP-1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for transfer TP-1" }));
    await user.click(within(await screen.findByRole("menu")).getByText("Dismiss"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "TP-1", gateway: "tokopay" }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
    );
  });

  it("offers only Dismiss on a NOWPayments row (its amount cannot be checked against an order), and bulk dismiss includes it", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 9, gateway: "nowpayments", reference: "NP-9", amount: "0.00123", currency: null, outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 1, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    vi.mocked(apiPost).mockResolvedValue({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("NP-9")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for transfer NP-9" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Dismiss")).toBeInTheDocument();
    expect(within(menu).queryByText("Match to order…")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Add to buyer's credit balance")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("checkbox", { name: "Select transfer NP-9" }));
    await user.click(screen.getByRole("button", { name: /dismiss 1 transfer/i }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "NP-9", gateway: "nowpayments" }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
    );
  });

  it("shows a NOWPayments amount as the plain coin amount, flagged as unconverted, when the server sends no currency", async () => {
    const ledger = [
      { id: 9, gateway: "nowpayments", reference: "NP-9", amount: "0.00123", currency: null, outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 10, gateway: "tokopay", reference: "TP-NOAMT", amount: null, currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 2, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("NP-9")).toBeInTheDocument());

    const amount = screen.getByText("0.00123");
    expect(amount).toHaveClass("font-mono");
    expect(amount).toHaveAttribute("title", "Amount in the buyer's payment coin — not converted");
    // A row with no amount still shows the dash.
    const noAmountRow = screen.getByText("TP-NOAMT").closest("tr")!;
    expect(within(noAmountRow).getAllByText("—").length).toBeGreaterThan(0);
  });

  // T5: a wallet top-up's payment was indistinguishable from a product sale
  // here — the ledger row carried only a numeric orderId.
  it("shows each row's order code and marks wallet top-ups apart from product sales", async () => {
    const ledger = [
      { id: 1, gateway: "tokopay", reference: "TP-SALE", amount: "50000", currency: "IDR", outcome: "matched", memo: null, orderId: 11, orderCode: "ORD-SALE", orderKind: "PRODUCT", processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 2, gateway: "tokopay", reference: "TP-TOPUP", amount: "100000", currency: "IDR", outcome: "matched", memo: null, orderId: 12, orderCode: "ORD-TOPUP", orderKind: "WALLET_TOPUP", processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 3, gateway: "binance", reference: "BN-ORPHAN", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, orderId: null, orderCode: null, orderKind: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 4, gateway: "tokopay", reference: "TP-CXL", amount: "1", currency: "IDR", outcome: "delivery_failed", memo: null, orderId: 13, orderCode: "ORD-CXL", orderKind: "PRODUCT", orderStatus: "CANCELLED", processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 4, todayCount: 0, page: 1, hasNext: false, outcomes: ["matched"], kinds: ["PRODUCT", "WALLET_TOPUP"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TP-SALE")).toBeInTheDocument());

    expect(screen.getByText("ORD-SALE")).toBeInTheDocument();
    expect(screen.getByText("ORD-TOPUP")).toBeInTheDocument();
    expect(screen.getByText("Wallet Topup")).toBeInTheDocument();
    expect(screen.getAllByText("Product").length).toBeGreaterThan(0);
    // A row with an order links to it and shows where that order ended up.
    expect(screen.getByRole("link", { name: "ORD-CXL" })).toHaveAttribute("href", "/orders/13");
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("shows an unmatched row's suggested order as a muted, labelled link, falls back to its kind for Type, and renders the amount with its currency", async () => {
    const ledger = [
      { id: 1, gateway: "tokopay", reference: "TP-SHORT", amount: "40000", currency: "IDR", outcome: "unmatched", memo: null, orderId: null, orderCode: null, orderKind: null, orderStatus: null, suggestedOrderId: 21, suggestedOrderCode: "ORD-HINTED", suggestedOrderKind: "WALLET_TOPUP", processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 2, gateway: "tokopay", reference: "TP-GHOST", amount: "1000", currency: "IDR", outcome: "unmatched", memo: null, orderId: null, orderCode: null, orderKind: null, orderStatus: null, suggestedOrderId: 22, suggestedOrderCode: null, suggestedOrderKind: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 2, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], kinds: ["PRODUCT", "WALLET_TOPUP"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TP-SHORT")).toBeInTheDocument());

    const link = screen.getByRole("link", { name: "ORD-HINTED" });
    expect(link).toHaveAttribute("href", "/orders/21");
    expect(link).toHaveClass("text-ink-soft");
    const shortRow = link.closest("tr")!;
    expect(within(shortRow).getByText("suggested")).toBeInTheDocument();
    expect(within(shortRow).getByTitle("Order this payment was meant for — not settled.")).toBeInTheDocument();
    // Type falls back to the suggested order's kind.
    expect(within(shortRow).getByText("Wallet Topup")).toBeInTheDocument();
    // Amount renders now that the server sends the currency.
    expect(within(shortRow).getByText(/40[.,]000/)).toBeInTheDocument();

    // A hint whose order code is unknown falls back to `#id`.
    expect(screen.getByRole("link", { name: "#22" })).toHaveAttribute("href", "/orders/22");
  });

  it("seeds the order-type filter from ?kind= in the URL on mount", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: [], kinds: ["PRODUCT", "WALLET_TOPUP"], counts: {} });
    render(
      <WrapperAt initialEntries={["/payments?kind=WALLET_TOPUP"]}>
        <PaymentsPage />
      </WrapperAt>,
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining("kind=WALLET_TOPUP")));
  });

  it("re-queries from page 1 when the order-type filter changes", async () => {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 3, hasNext: false, outcomes: [], kinds: ["PRODUCT", "WALLET_TOPUP"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());

    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: [], kinds: ["PRODUCT", "WALLET_TOPUP"], counts: {} });
    await user.click(screen.getByRole("combobox", { name: /order type/i }));
    await user.click(await screen.findByRole("option", { name: "Wallet Topup" }));

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining("kind=WALLET_TOPUP")));
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining("page=1"));
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
  it("shows the server's true underpaid total on the badge, not the length of the capped list", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], underpaidCount: 63, pendingInternal: [] });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    const heading = screen.getByText("Underpaid Orders").closest('[data-slot="card-title"]') as HTMLElement;
    expect(within(heading).getByText("63")).toBeInTheDocument();
    expect(within(heading).queryByText("1")).not.toBeInTheDocument();
    // Only one row is listed, so say the list is shorter than the total.
    expect(screen.getByText("Showing the 1 most recent of 63.")).toBeInTheDocument();
  });

  it("says nothing about a truncated list when every underpaid order is listed", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], underpaidCount: 1, pendingInternal: [] });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    const heading = screen.getByText("Underpaid Orders").closest('[data-slot="card-title"]') as HTMLElement;
    expect(within(heading).getByText("1")).toBeInTheDocument();
    expect(screen.queryByText(/most recent of/)).not.toBeInTheDocument();
  });

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
    expect(within(dialog).getByRole("button", { name: "Deliver anyway" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Override reason"), "Approved shortfall");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deliver anyway" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/deliver", { reason: "Approved shortfall" }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
  });

  it("refunds an underpaid order to the buyer's wallet", async () => {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, refunded: "18500", currency: "IDR" });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for order ORD-UP1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Refund"));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Refund" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/refund", {}, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    // Names the amount that actually went back, so the admin can check it
    // against what the buyer says they sent.
    expect(await screen.findByText("Order refunded and Rp18.500 returned to the buyer's balance.")).toBeInTheDocument();
  });

  // Same latent bug the credit-anyway warning below fixes, on the PRODUCT-order
  // sibling button: a PRODUCT order flagged UNDERPAID before this branch's
  // ledger table landed has no record of what arrived, so it goes REFUNDED with
  // nothing paid back. REFUNDED is terminal — an unconditional success toast
  // would be the admin's last word on an order nobody ever refunded.
  it("warns instead of claiming success when the refund response returned nothing", async () => {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, refunded: "0", currency: "IDR" });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for order ORD-UP1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Refund"));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Refund" }));

    // Names the order code: by now the order is REFUNDED and has dropped out of
    // the Underpaid panel, so the toast is the admin's only handle on it.
    expect(await screen.findByText(/ORD-UP1 marked refunded but nothing could be returned automatically/)).toBeInTheDocument();
    expect(screen.queryByText(/returned to the buyer's balance\./)).not.toBeInTheDocument();
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

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/cancel", {}, expect.objectContaining({ idempotencyKey: expect.any(String) })));
  });

  it("shows only 'Credit to balance anyway' and 'Cancel order' for a WALLET_TOPUP underpaid row, and credits it", async () => {
    const user = userEvent.setup();
    const topup = { ...UNDERPAID, kind: "WALLET_TOPUP" };
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [topup], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, credited: "4.25", currency: "USDT" });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for order ORD-UP1" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Credit to balance anyway")).toBeInTheDocument();
    expect(within(menu).getByText("Cancel order")).toBeInTheDocument();
    expect(within(menu).queryByText("Deliver anyway")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Refund")).not.toBeInTheDocument();

    await user.click(within(menu).getByText("Credit to balance anyway"));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Credit anyway" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/credit-anyway", {}, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    // Names the amount that actually moved, so the admin can check it against
    // what the buyer says they sent.
    expect(await screen.findByText("Order cancelled and 4.25 USDT credited to the buyer's balance.")).toBeInTheDocument();
  });

  // The route cancels the order either way, but credits nothing when no rail
  // recorded what arrived (every WALLET_TOPUP order already sitting in
  // UNDERPAID before this branch's QRIS ledger landed is in that state). The
  // old unconditional success toast told the admin money moved when it had
  // not, and CANCELLED is terminal — nothing later would correct them.
  it("warns instead of claiming success when the credit-anyway response credited nothing", async () => {
    const user = userEvent.setup();
    const topup = { ...UNDERPAID, kind: "WALLET_TOPUP" };
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [topup], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, credited: "0", currency: "USDT" });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for order ORD-UP1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Credit to balance anyway"));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Credit anyway" }));

    // Names the order code: by now the order is CANCELLED and has dropped out
    // of the Underpaid panel, so the toast is the admin's only handle on it.
    const warning = await screen.findByText(/ORD-UP1 cancelled but nothing could be credited automatically/);
    expect(warning).toBeInTheDocument();
    expect(screen.queryByText(/credited to the buyer's balance\./)).not.toBeInTheDocument();
  });

  it("keeps a PRODUCT underpaid row's menu unchanged (all three original actions)", async () => {
    const user = userEvent.setup();
    const productRow = { ...UNDERPAID, kind: "PRODUCT" };
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [productRow], pendingInternal: [] });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for order ORD-UP1" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Deliver anyway")).toBeInTheDocument();
    expect(within(menu).getByText("Refund")).toBeInTheDocument();
    expect(within(menu).getByText("Cancel order")).toBeInTheDocument();
    expect(within(menu).queryByText("Credit to balance anyway")).not.toBeInTheDocument();
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
    await user.type(within(dialog).getByLabelText("Override reason"), "Approved shortfall");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deliver anyway" }));

    expect(await screen.findByText("Order is no longer underpaid.")).toBeInTheDocument();
  });

  // P2. "Deliver anyway" on a manual-delivery SKU runs `approveOrder`'s stock
  // allocation, which refuses with `error.cannot_deliver_out_of_stock` naming the
  // product (crud/orders.ts) — see crud/binance_internal.ts's own comment on
  // `deliverUnderpaidOrder`, which calls this the expected failure for that SKU.
  // The route used to send the key alone, so an admin with several underpaid
  // orders open was told "this item" and left to guess which one. The figure now
  // travels as `error_args` and `describeError` puts it in the toast.
  it("names the product in a stock refusal instead of saying 'this item'", async () => {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockRejectedValueOnce(
      Object.assign(new Error("error.cannot_deliver_out_of_stock"), {
        status: 422,
        errorArgs: { product: "Mobile Legends 86 Diamonds" },
      }),
    );
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for order ORD-UP1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Deliver anyway"));

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Override reason"), "Approved shortfall");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deliver anyway" }));

    expect(
      await screen.findByText(
        "Mobile Legends 86 Diamonds has no stock reserved and can't be delivered automatically — refund or credit the buyer instead.",
      ),
    ).toBeInTheDocument();
    // The braces themselves must never reach an admin — that is the whole F4a
    // failure mode, one surface over.
    expect(screen.queryByText(/\{product\}/)).not.toBeInTheDocument();
  });
});

// Idempotency-Key. All six payment mutations read one (see
// src/routes/api/payments.ts). These assert the header VALUE across two
// attempts, not merely that apiPost was called.
//
// The lifecycle is exercised through bulk dismiss rather than the row-action
// dialogs: `ConfirmDialog` closes as soon as its confirm button is clicked
// (its `onConfirm` is a fire-and-forget `mutate`), and under jsdom Radix
// leaves `aria-hidden` / `pointer-events: none` behind when that dialog is
// unmounted by its parent instead of closed through its own animation — so a
// second pass through the menu is unreachable for reasons that have nothing to
// do with the key. Bulk dismiss touches the same `/api/payments/dismiss`
// route and the same `useIdempotentPost` instance with no modal in the way.
describe("PaymentsPage — Idempotency-Key", () => {
  const DISMISS_PATH = "/api/payments/dismiss";

  /** The keys the calls to `path` carried, in click order. */
  function keysFor(path: string): string[] {
    return vi
      .mocked(apiPost)
      .mock.calls.filter((c) => c[0] === path)
      .map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
  }

  const LEDGER = [
    { id: 1, gateway: "binance", reference: "BULK1", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    { id: 2, gateway: "binance", reference: "BULK2", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
  ];

  async function renderLedger(rows = LEDGER) {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: rows, total: rows.length, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(rows[0]!.reference)).toBeInTheDocument());
    return user;
  }

  /** Select BULK1 and dismiss it. The selection is cleared after each run, so
   * calling this twice is the admin retrying the same transfer. */
  async function dismissBulk1(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("checkbox", { name: /select transfer bulk1/i }));
    await user.click(await screen.findByRole("button", { name: /dismiss 1 transfer/i }));
  }

  it("retrying a dismiss whose request never came back sends the byte-identical key", async () => {
    // A transport failure: `onResponse` never fires, so the outcome is
    // unknown — the dismiss may already have landed and only the response
    // lost. This is exactly the retry that must be deduped.
    vi.mocked(apiPost).mockRejectedValue(new TypeError("Failed to fetch"));
    const user = await renderLedger([LEDGER[0]!]);

    await dismissBulk1(user);
    await waitFor(() => expect(keysFor(DISMISS_PATH)).toHaveLength(1));
    await dismissBulk1(user);
    await waitFor(() => expect(keysFor(DISMISS_PATH)).toHaveLength(2));

    const [first, second] = keysFor(DISMISS_PATH);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
  });

  it("mints a fresh key for the next attempt once the server has answered", async () => {
    // A received 4xx — the outcome is known and the route has already stored
    // it against the key, so reusing the key could only replay that same
    // error even after the transfer's state has moved on.
    vi.mocked(apiPost).mockImplementation(
      async (_path: string, _body: unknown, options?: { onResponse?: (status: number) => void }) => {
        options?.onResponse?.(404);
        throw new Error("Transfer not found.");
      },
    );
    const user = await renderLedger([LEDGER[0]!]);

    await dismissBulk1(user);
    await waitFor(() => expect(keysFor(DISMISS_PATH)).toHaveLength(1));
    await dismissBulk1(user);
    await waitFor(() => expect(keysFor(DISMISS_PATH)).toHaveLength(2));

    const [first, second] = keysFor(DISMISS_PATH);
    expect(second).not.toBe(first);
  });

  // A 504 is the reverse proxy giving up, not the app answering: the mutation
  // may have completed and stored its real 200. Nothing 5xx is ever stored, so
  // holding the key costs nothing and dropping it would risk a second action.
  it("holds the key across a 504, which says nothing about whether the mutation ran", async () => {
    vi.mocked(apiPost).mockImplementation(
      async (_path: string, _body: unknown, options?: { onResponse?: (status: number) => void }) => {
        options?.onResponse?.(504);
        throw new Error("/api/payments/dismiss responded 504");
      },
    );
    const user = await renderLedger([LEDGER[0]!]);

    await dismissBulk1(user);
    await waitFor(() => expect(keysFor(DISMISS_PATH)).toHaveLength(1));
    await dismissBulk1(user);
    await waitFor(() => expect(keysFor(DISMISS_PATH)).toHaveLength(2));

    const [first, second] = keysFor(DISMISS_PATH);
    expect(second).toBe(first);
  });

  it("gives each transfer in a bulk dismiss its own key", async () => {
    vi.mocked(apiPost).mockResolvedValue({ ok: true });
    const user = await renderLedger();

    await user.click(screen.getByRole("checkbox", { name: /select transfer bulk1/i }));
    await user.click(screen.getByRole("checkbox", { name: /select transfer bulk2/i }));
    await user.click(screen.getByRole("button", { name: /dismiss 2 transfers/i }));

    await waitFor(() => expect(keysFor(DISMISS_PATH)).toHaveLength(2));
    const [first, second] = keysFor(DISMISS_PATH);
    // Two different transfers are two different logical operations — sharing
    // one key would earn a 409 `idempotency_key_reused` on the second.
    expect(second).not.toBe(first);
  });
});
