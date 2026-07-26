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

const STATS = { active: 1, scheduled: 0, expired: 0, totalRedemptions: 0 };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function listResponse(vouchers: unknown[], overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    vouchers,
    types: ["PERCENT", "FIXED"],
    scopes: ["ALL", "SELECTED"],
    total: vouchers.length,
    page: 1,
    pageSize: 50,
    stats: STATS,
    ...overrides,
  });
}

const VOUCHER = {
  id: 1,
  code: "SAVE10",
  type: "PERCENT",
  value: "10",
  isActive: true,
  usageLimit: 100,
  usedCount: 5,
  minPurchase: "0",
  expiresAt: null,
  expiresAtDisplay: null,
  scope: "ALL",
  maxDiscount: null,
  startAt: null,
  products: [],
  status: "active",
  ordersCount: 3,
  revenue: "150000",
  customers: 2,
};

// Active, no expiry set within the next 7 days -> should NOT be flagged as expiring soon.
// value has 5 digits (not just "5") so the IDR-formatting test actually exercises
// thousands-grouping (formatCurrencyDisplay turning 50000 into "Rp50.000").
const FAR_FUTURE_VOUCHER = {
  ...VOUCHER,
  id: 2,
  code: "FARAWAY",
  type: "FIXED",
  value: "50000",
  usageLimit: null,
  usedCount: 0,
  expiresAt: daysFromNow(30),
};

// Active, expires in 3 days -> should be flagged as expiring soon.
const EXPIRING_SOON_VOUCHER = {
  ...VOUCHER,
  id: 3,
  code: "SOONISH",
  type: "PERCENT",
  value: "15",
  usageLimit: null,
  usedCount: 0,
  expiresAt: daysFromNow(3),
};

// Already expired -> must render "Expired", muted, not "Expiring soon".
const EXPIRED_VOUCHER = {
  ...VOUCHER,
  id: 4,
  code: "OLDCODE",
  type: "PERCENT",
  value: "20",
  usageLimit: null,
  usedCount: 0,
  expiresAt: daysFromNow(-1),
  status: "expired",
};

// Fully used up, expires in 2 days -> must NOT be flagged "expiring soon" (no longer usable).
const USED_UP_VOUCHER = {
  ...VOUCHER,
  id: 5,
  code: "ALLGONE",
  type: "FIXED",
  value: "1",
  usageLimit: 10,
  usedCount: 10,
  expiresAt: daysFromNow(2),
  status: "usedUp",
};

const SELECTED_SCOPE_VOUCHER = {
  ...VOUCHER,
  id: 6,
  code: "STREAM20",
  type: "PERCENT",
  value: "20",
  usageLimit: 100,
  usedCount: 5,
  minPurchase: "50000",
  maxDiscount: "25000",
  scope: "SELECTED",
  products: [
    { id: 5, name: "Netflix Premium" },
    { id: 7, name: "Spotify Family" },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select/Popover use pointer-capture APIs and scrollIntoView — jsdom
  // doesn't implement them. Mock all three to prevent unhandled errors when a
  // dropdown/popover opens and focuses its first item.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("VouchersPage", () => {
  it("renders voucher rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([VOUCHER]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());
    expect(screen.getByText("Percent off")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
  });

  it("formats FIXED-type vouchers as IDR currency", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([FAR_FUTURE_VOUCHER]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("FARAWAY")).toBeInTheDocument());
    expect(screen.getByText("Fixed amount off")).toBeInTheDocument();
    expect(screen.getByText("Rp50.000 Off")).toBeInTheDocument();
  });

  it("shows a KPI row sourced from the server-wide stats field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      listResponse([VOUCHER], { stats: { active: 30, scheduled: 3, expired: 5, totalRedemptions: 42 } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByText("Total Redemptions")).toBeInTheDocument();
  });

  it("shows empty state when no vouchers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([]));
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
      ...VOUCHER,
      id: 7,
      code: "MIDNIGHT",
      usageLimit: null,
      usedCount: 0,
      // Raw UTC midnight would slice(0, 10) to "2026-07-01" — the shop's
      // TIMEZONE (Asia/Jakarta, +7) display should be the same calendar day
      // here, but the point is the page must render the server's
      // expiresAtDisplay string, not compute it from the raw ISO value.
      expiresAt: daysFromNow(60),
      expiresAtDisplay: "2026-07-01",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([voucherWithExpiry]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("MIDNIGHT")).toBeInTheDocument());
    expect(screen.getByText("Ends 2026-07-01")).toBeInTheDocument();
  });

  it("copies the voucher code to the clipboard", async () => {
    // `userEvent.setup()` installs its own working clipboard stub on
    // `navigator.clipboard` (jsdom has no real implementation), so we spy on
    // that stub's `writeText` — pre-mocking `navigator.clipboard` ourselves
    // would just get overwritten by user-event's setup.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([VOUCHER]));
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
      listResponse([FAR_FUTURE_VOUCHER, EXPIRING_SOON_VOUCHER, EXPIRED_VOUCHER, USED_UP_VOUCHER]),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SOONISH")).toBeInTheDocument());

    const rows = screen.getAllByRole("row");
    const rowFor = (code: string) => rows.find(r => within(r).queryByText(code));

    expect(within(rowFor("SOONISH")!).getByText(/expires in \d+ days?/i)).toBeInTheDocument();
    expect(within(rowFor("FARAWAY")!).queryByText(/expires in/i)).not.toBeInTheDocument();
    // Both the Expiration cell and the Status badge independently render
    // "Expired" for this row — a real UI overlap, not a test bug.
    expect(within(rowFor("OLDCODE")!).getAllByText("Expired")).toHaveLength(2);
    expect(within(rowFor("ALLGONE")!).queryByText(/expires in/i)).not.toBeInTheDocument();
  });

  it("renders the Scope column as plain text for ALL and up to 2 product badges + overflow badge for SELECTED", async () => {
    const manyProducts = {
      ...SELECTED_SCOPE_VOUCHER,
      id: 8,
      code: "MANYPROD",
      products: [
        { id: 1, name: "Netflix Premium" },
        { id: 2, name: "Spotify Family" },
        { id: 3, name: "YouTube Premium" },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([VOUCHER, manyProducts]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    expect(screen.getByText("All Products")).toBeInTheDocument();
    expect(screen.getByText("Netflix Premium")).toBeInTheDocument();
    expect(screen.getByText("Spotify Family")).toBeInTheDocument();
    expect(screen.queryByText("YouTube Premium")).not.toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
  });

  it("renders Performance and Usage columns from server-computed fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([VOUCHER]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    expect(screen.getByText("5/100")).toBeInTheDocument();
    expect(screen.getByText("3 orders")).toBeInTheDocument();
    expect(screen.getByText("Rp150.000 · 2 customers")).toBeInTheDocument();
  });

  it("renders the Status column via StatusBadge from the server status field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([USED_UP_VOUCHER]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ALLGONE")).toBeInTheDocument());
    expect(screen.getByText("Usage Limit Reached")).toBeInTheDocument();
  });

  it("debounces a code search into the query params", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await vi.waitFor(() => expect(screen.getByText(/no vouchers/i)).toBeInTheDocument());

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(listResponse([]));
    const search = screen.getByPlaceholderText(/search voucher code/i);
    fireEvent.change(search, { target: { value: "SAVE" } });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("q=SAVE")));
    vi.useRealTimers();
  });

  it("sends the status filter as a server query param instead of filtering client-side", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([VOUCHER]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(listResponse([]));
    await user.click(screen.getByRole("combobox", { name: "" }));
    await waitFor(() => screen.getByRole("option", { name: "Expired" }));
    await user.click(screen.getByRole("option", { name: "Expired" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("status=expired")));
  });

  it("gives every inline 'New Voucher' field a persistent visible label, including the Type and Scope combobox (F-014)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no vouchers/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "New Voucher" }));

    expect(screen.getByLabelText(/^code/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^value/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/min purchase/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/max discount/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/usage limit/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^starts/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^expires/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Scope" })).toBeInTheDocument();
  });

  it("shows the product picker only once Scope is set to Selected Products", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no vouchers/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "New Voucher" }));
    expect(screen.queryByText("Select products")).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Scope" }));
    await waitFor(() => screen.getByRole("option", { name: "Selected Products" }));
    await user.click(screen.getByRole("option", { name: "Selected Products" }));

    expect(screen.getByText("Select products")).toBeInTheDocument();
  });

  it("creates a SELECTED-scope voucher via a single POST /api/vouchers call, never the update endpoint", async () => {
    // Regression test for the create-route gap found in review: POST
    // /api/vouchers used to only accept the original 6 fields, so this page
    // had to chain an immediate POST .../update to actually persist
    // scope/product_ids on create. The route now accepts all 10 fields
    // directly (mirrors the update route's validation), so Create (and
    // Duplicate, which shares this same mutation) must never call the
    // update endpoint.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no vouchers/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "New Voucher" }));
    await user.type(screen.getByLabelText(/^code/i), "NEWSEL");
    await user.type(screen.getByLabelText(/^value/i), "15");

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ categories: [], products: [] })) // GET /api/catalog (picker mounts)
      .mockResolvedValueOnce(jsonResponse({ voucher: { id: 42, code: "NEWSEL" } })) // POST /api/vouchers
      .mockResolvedValueOnce(listResponse([])); // GET /api/vouchers refetch after invalidate

    await user.click(screen.getByRole("combobox", { name: "Scope" }));
    await waitFor(() => screen.getByRole("option", { name: "Selected Products" }));
    await user.click(screen.getByRole("option", { name: "Selected Products" }));
    await waitFor(() => expect(screen.getByText("Select products")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      "/api/vouchers",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"scope":"SELECTED"'),
      }),
    ));

    const requestedUrls = fetchSpy.mock.calls.map(call => call[0]);
    expect(requestedUrls.filter(url => url === "/api/vouchers")).toHaveLength(1);
    expect(requestedUrls.some(url => typeof url === "string" && url.includes("/update"))).toBe(false);

    // Drain the invalidated-query refetch too, so no pending fetch() call
    // from this test's mocked queue leaks into the next test.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
  });

  it("edits a voucher: pre-fills the form and PATCHes via the update endpoint", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([VOUCHER]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for SAVE10" }));
    await user.click(await screen.findByRole("menuitem", { name: /^edit$/i }));

    expect(await screen.findByText("Edit Voucher")).toBeInTheDocument();
    expect(screen.getByLabelText(/^code/i)).toHaveValue("SAVE10");

    const postSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ voucher: { ...VOUCHER } }),
    );
    postSpy.mockResolvedValueOnce(listResponse([VOUCHER]));

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith(
      "/api/vouchers/1/update",
      expect.objectContaining({ method: "POST" }),
    ));
    // Drain the invalidated-query refetch too, so no pending fetch() call
    // from this test's mocked queue leaks into the next test.
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2));
  });

  it("duplicates a voucher: pre-fills the form with a blank code and posts to the create endpoint", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([VOUCHER]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for SAVE10" }));
    await user.click(await screen.findByRole("menuitem", { name: /duplicate/i }));

    expect(await screen.findByText("New Voucher")).toBeInTheDocument();
    expect(screen.getByLabelText(/^code/i)).toHaveValue("");

    const postSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ voucher: { id: 99, code: "SAVE10" } }),
    );
    postSpy.mockResolvedValueOnce(listResponse([VOUCHER]));

    await user.type(screen.getByLabelText(/^code/i), "SAVE10COPY");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith(
      "/api/vouchers",
      expect.objectContaining({ method: "POST" }),
    ));
    // Drain the invalidated-query refetch too, so no pending fetch() call
    // from this test's mocked queue leaks into the next test.
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2));
  });

  it("opens a read-only View dialog with the full voucher detail", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([SELECTED_SCOPE_VOUCHER]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("STREAM20")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for STREAM20" }));
    await user.click(await screen.findByRole("menuitem", { name: /^view$/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("STREAM20")).toBeInTheDocument();
    expect(within(dialog).getByText("Netflix Premium")).toBeInTheDocument();
    expect(within(dialog).getByText("Spotify Family")).toBeInTheDocument();
  });

  it("toggles a voucher's active state via the Enable/Disable dropdown action", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([VOUCHER]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    const postSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: true }),
    );
    postSpy.mockResolvedValueOnce(listResponse([VOUCHER]));

    await user.click(screen.getByRole("button", { name: "Actions for SAVE10" }));
    await user.click(await screen.findByRole("menuitem", { name: /^disable$/i }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith(
      "/api/vouchers/1/toggle",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ is_active: "0" }) }),
    ));
    // Drain the invalidated-query refetch too, so no pending fetch() call
    // from this test's mocked queue leaks into the next test.
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2));
  });

  it("deletes a voucher via the dropdown's Delete action and confirm dialog", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([VOUCHER]));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for SAVE10" }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

    expect(await screen.findByText('Permanently delete voucher "SAVE10".')).toBeInTheDocument();

    const postSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: true }),
    );
    postSpy.mockResolvedValueOnce(listResponse([]));

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith(
      "/api/vouchers/1/delete",
      expect.objectContaining({ method: "POST" }),
    ));
    // Drain the invalidated-query refetch too, so no pending fetch() call
    // from this test's mocked queue leaks into the next test.
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2));
  });

  it("bulk-deactivates selected vouchers", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const vouchers = [
      { ...VOUCHER, id: 1, code: "BULKV1" },
      { ...VOUCHER, id: 2, code: "BULKV2" },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse(vouchers, { total: 2 }));
    const postSpy = vi.spyOn(globalThis, "fetch");
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("BULKV1")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select voucher bulkv1/i }));
    await user.click(screen.getByRole("checkbox", { name: /select voucher bulkv2/i }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    postSpy.mockResolvedValueOnce(
      jsonResponse({ succeeded: [1, 2], failed: [] }),
    );
    postSpy.mockResolvedValueOnce(listResponse([], { total: 2 }));

    await user.click(screen.getByRole("button", { name: /deactivate 2 vouchers/i }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith("/api/vouchers/bulk-action", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ ids: [1, 2], action: "deactivate" }),
    })));
  });

  it("clears the bulk selection when the page changes", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const vouchers = [{ ...VOUCHER, id: 1, code: "PAGEV1" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse(vouchers, { total: 60 }));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("PAGEV1")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select voucher pagev1/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      listResponse([{ ...VOUCHER, id: 2, code: "PAGEV2" }], { total: 60, page: 2 }),
    );
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(screen.getByText("PAGEV2")).toBeInTheDocument());

    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("shows result-count text via the shared Pagination component", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(listResponse([VOUCHER], { total: 120 }));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());
    expect(screen.getByText(/showing 1–50 of 120/i)).toBeInTheDocument();
  });
});
