import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VouchersPage } from "./VouchersPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

const VOUCHER = { id: 1, code: "SAVE10", type: "PERCENT", value: "10", isActive: true, usageLimit: 100, usedCount: 5, minPurchase: "0", expiresAt: null, expiresAtDisplay: null };

// Active, no expiry set within the next 7 days -> should NOT be flagged as expiring soon.
// value has 5 digits (not just "5") so the IDR-formatting test actually exercises
// thousands-grouping (formatCurrencyDisplay turning 50000 into "Rp50.000").
const FAR_FUTURE_VOUCHER = { id: 2, code: "FARAWAY", type: "FIXED", value: "50000", isActive: true, usageLimit: null, usedCount: 0, minPurchase: "0", expiresAt: daysFromNow(30) };

// Active, expires in 3 days -> should be flagged as expiring soon.
const EXPIRING_SOON_VOUCHER = { id: 3, code: "SOONISH", type: "PERCENT", value: "15", isActive: true, usageLimit: null, usedCount: 0, minPurchase: "0", expiresAt: daysFromNow(3) };

// Already expired -> must NOT be flagged as expiring soon, even though technically "in the past 7 days".
const EXPIRED_VOUCHER = { id: 4, code: "OLDCODE", type: "PERCENT", value: "20", isActive: true, usageLimit: null, usedCount: 0, minPurchase: "0", expiresAt: daysFromNow(-1) };

// Fully used up, expires in 2 days -> must NOT be flagged as expiring soon (no longer usable).
const USED_UP_VOUCHER = { id: 5, code: "ALLGONE", type: "FIXED", value: "1", isActive: true, usageLimit: 10, usedCount: 10, minPurchase: "0", expiresAt: daysFromNow(2) };

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them. Mock all three to prevent unhandled errors when the
  // dropdown opens and focuses the first option.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("VouchersPage", () => {
  it("renders voucher rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vouchers: [VOUCHER],
          types: ["PERCENT", "FIXED"],
          total: 1,
          page: 1,
          pageSize: 50,
          stats: { total: 1, active: 1, expiringSoon: 0, usedUp: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());
    expect(screen.getByText("Percent")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
  });

  it("formats FIXED-type vouchers as IDR currency", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vouchers: [FAR_FUTURE_VOUCHER],
          types: ["PERCENT", "FIXED"],
          total: 1,
          page: 1,
          pageSize: 50,
          stats: { total: 1, active: 1, expiringSoon: 0, usedUp: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("FARAWAY")).toBeInTheDocument());
    expect(screen.getByText("Fixed")).toBeInTheDocument();
    expect(screen.getByText("Rp50.000")).toBeInTheDocument();
  });

  it("shows a KPI row sourced from the server-wide stats field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vouchers: [VOUCHER],
          types: ["PERCENT", "FIXED"],
          total: 1,
          page: 1,
          pageSize: 50,
          stats: { total: 42, active: 30, expiringSoon: 3, usedUp: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("shows empty state when no vouchers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vouchers: [],
          types: [],
          total: 0,
          page: 1,
          pageSize: 50,
          stats: { total: 0, active: 0, expiringSoon: 0, usedUp: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no vouchers/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("renders the server-formatted expiry date, not a raw UTC-date substring", async () => {
    const voucherWithExpiry = {
      id: 6,
      code: "MIDNIGHT",
      type: "PERCENT",
      value: "10",
      isActive: true,
      usageLimit: null,
      usedCount: 0,
      minPurchase: "0",
      // Raw UTC midnight would slice(0, 10) to "2026-07-01" — the shop's
      // TIMEZONE (Asia/Jakarta, +7) display should be the same calendar day
      // here, but the point is the page must render the server's
      // expiresAtDisplay string, not compute it from the raw ISO value.
      expiresAt: "2026-07-01T00:00:00.000Z",
      expiresAtDisplay: "2026-07-01",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vouchers: [voucherWithExpiry],
          types: ["PERCENT", "FIXED"],
          total: 1,
          page: 1,
          pageSize: 50,
          stats: { total: 1, active: 1, expiringSoon: 0, usedUp: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("MIDNIGHT")).toBeInTheDocument());
    expect(screen.getByText("2026-07-01")).toBeInTheDocument();
  });

  it("copies the voucher code to the clipboard", async () => {
    // `userEvent.setup()` installs its own working clipboard stub on
    // `navigator.clipboard` (jsdom has no real implementation), so we spy on
    // that stub's `writeText` — pre-mocking `navigator.clipboard` ourselves
    // would just get overwritten by user-event's setup.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vouchers: [VOUCHER],
          types: ["PERCENT", "FIXED"],
          total: 1,
          page: 1,
          pageSize: 50,
          stats: { total: 1, active: 1, expiringSoon: 0, usedUp: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    const copyButton = screen.getByRole("button", { name: /copy code save10/i });
    await user.click(copyButton);

    expect(writeText).toHaveBeenCalledWith("SAVE10");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(await navigator.clipboard.readText()).toBe("SAVE10");

    // Icon swaps to a checkmark confirmation after copying.
    await waitFor(() => expect(copyButton.querySelector("svg.lucide-check")).toBeInTheDocument());
  });

  it("flags a voucher expiring within 7 days, but not an expired, far-future, or used-up one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vouchers: [FAR_FUTURE_VOUCHER, EXPIRING_SOON_VOUCHER, EXPIRED_VOUCHER, USED_UP_VOUCHER],
          types: ["PERCENT", "FIXED"],
          total: 4,
          page: 1,
          pageSize: 50,
          stats: { total: 4, active: 1, expiringSoon: 1, usedUp: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SOONISH")).toBeInTheDocument());

    const rows = screen.getAllByRole("row");
    const rowFor = (code: string) => rows.find(r => within(r).queryByText(code));

    expect(within(rowFor("SOONISH")!).getByText(/expiring soon/i)).toBeInTheDocument();
    expect(within(rowFor("FARAWAY")!).queryByText(/expiring soon/i)).not.toBeInTheDocument();
    expect(within(rowFor("OLDCODE")!).queryByText(/expiring soon/i)).not.toBeInTheDocument();
    expect(within(rowFor("ALLGONE")!).queryByText(/expiring soon/i)).not.toBeInTheDocument();
  });

  it("debounces a code search into the query params", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [], types: [], total: 0, page: 1, pageSize: 50, stats: { total: 0, active: 0, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await vi.waitFor(() => expect(screen.getByText(/no vouchers/i)).toBeInTheDocument());

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ vouchers: [], types: [], total: 0, page: 1, pageSize: 50, stats: { total: 0, active: 0, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const search = screen.getByPlaceholderText(/search voucher code/i);
    fireEvent.change(search, { target: { value: "SAVE" } });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("q=SAVE")));
    vi.useRealTimers();
  });

  it("sends the status filter as a server query param instead of filtering client-side", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [VOUCHER], types: ["PERCENT", "FIXED"], total: 1, page: 1, pageSize: 50, stats: { total: 1, active: 1, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ vouchers: [], types: [], total: 0, page: 1, pageSize: 50, stats: { total: 1, active: 0, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Expired" }));
    await user.click(screen.getByRole("option", { name: "Expired" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("status=expired")));
  });

  it("gives every inline 'New Voucher' field a persistent visible label, including the Type combobox (F-014)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vouchers: [],
          types: ["PERCENT", "FIXED"],
          total: 0,
          page: 1,
          pageSize: 50,
          stats: { total: 0, active: 0, expiringSoon: 0, usedUp: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no vouchers/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "New Voucher" }));

    expect(screen.getByLabelText(/^code/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^value/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/min purchase/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/usage limit/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/expires/i)).toBeInTheDocument();
  });

  it("bulk-deactivates selected vouchers", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const vouchers = [
      { ...VOUCHER, id: 1, code: "BULKV1" },
      { ...VOUCHER, id: 2, code: "BULKV2" },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers, types: ["PERCENT", "FIXED"], total: 2, page: 1, pageSize: 50, stats: { total: 2, active: 2, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const postSpy = vi.spyOn(globalThis, "fetch");
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("BULKV1")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select voucher bulkv1/i }));
    await user.click(screen.getByRole("checkbox", { name: /select voucher bulkv2/i }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    postSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ succeeded: [1, 2], failed: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    postSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [], types: [], total: 0, page: 1, pageSize: 50, stats: { total: 2, active: 0, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await user.click(screen.getByRole("button", { name: /deactivate 2 vouchers/i }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith("/api/vouchers/bulk-action", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ ids: [1, 2], action: "deactivate" }),
    })));
  });

  it("clears the bulk selection when the page changes", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const vouchers = [{ ...VOUCHER, id: 1, code: "PAGEV1" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers, types: ["PERCENT", "FIXED"], total: 60, page: 1, pageSize: 50, stats: { total: 60, active: 60, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("PAGEV1")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select voucher pagev1/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [{ ...VOUCHER, id: 2, code: "PAGEV2" }], types: [], total: 60, page: 2, pageSize: 50, stats: { total: 60, active: 60, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(screen.getByText("PAGEV2")).toBeInTheDocument());

    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("shows result-count text via the shared Pagination component", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [VOUCHER], types: ["PERCENT", "FIXED"], total: 120, page: 1, pageSize: 50, stats: { total: 120, active: 120, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());
    expect(screen.getByText(/showing 1–50 of 120/i)).toBeInTheDocument();
  });
});
