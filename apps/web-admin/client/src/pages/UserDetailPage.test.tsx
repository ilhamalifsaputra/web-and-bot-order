import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { UserDetailPage } from "./UserDetailPage";
import { apiPost } from "../api/client";

// Task 2 (fetch → shared Application Client): UserDetailPage's useUserDetail
// now calls apiGet(...) instead of raw fetch(), so the mocked module needs an
// apiGet too — implemented as a thin forward to the global `fetch` this
// file's tests already stub per-test via vi.spyOn(globalThis, "fetch"), so
// every existing test body keeps working unchanged.
vi.mock("../api/client", () => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(async (path: string) => {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path} failed`);
    return res.json();
  }),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/users/7"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/users/:userId" element={children} />
        </Routes>
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const USER_DETAIL = {
  user: { id: 7, username: "andi", fullName: "Andi Santoso", telegramId: "111", role: "CUSTOMER", banned: false, banReason: null, walletBalance: "500000", walletBalanceUsdt: "12.5", preferredCurrency: null },
  totalSpent: { idr: "150000", usdt: "0" },
  orders: [],
  ordersTotal: 0,
  tickets: [],
  ticketsTotal: 0,
  ledger: [],
  ledgerTotal: 0,
  roles: ["CUSTOMER", "RESELLER"],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiPost).mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("UserDetailPage — role change", () => {
  it("renders the current role in an editable Select instead of a static badge", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("changes the role via POST /api/users/:userId/role", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "RESELLER" }));
    await user.click(screen.getByRole("option", { name: "RESELLER" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/users/7/role", { role: "RESELLER" }));
  });

  it("shows a static badge (no Select) for an ADMIN user — admin status is managed elsewhere", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...USER_DETAIL, user: { ...USER_DETAIL.user, role: "ADMIN" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("shows a toast on a failed role change", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockRejectedValueOnce(new Error("Invalid role."));
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "RESELLER" }));
    await user.click(screen.getByRole("option", { name: "RESELLER" }));

    expect(await screen.findByText("Invalid role.")).toBeInTheDocument();
  });
});

describe("UserDetailPage — display currency badge (Task 6, read-only)", () => {
  // The Profile card's "Display Currency" row, scoped away from the Wallet/
  // Total Spent CurrencyStack rows below it, which also render bare "IDR"/
  // "USD" text as a currency-amount label.
  function displayCurrencyRow(): HTMLElement {
    return screen.getByText("Display Currency").closest("div")!;
  }

  it("shows a USD badge for a USD preference", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...USER_DETAIL, user: { ...USER_DETAIL.user, preferredCurrency: "USD" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(within(displayCurrencyRow()).getByText("USD")).toBeInTheDocument();
  });

  it("shows an IDR badge for an IDR preference", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...USER_DETAIL, user: { ...USER_DETAIL.user, preferredCurrency: "IDR" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(within(displayCurrencyRow()).getByText("IDR")).toBeInTheDocument();
  });

  it("shows 'Not set' when the user has no preference, with no edit control offered", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...USER_DETAIL, user: { ...USER_DETAIL.user, preferredCurrency: null } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(within(displayCurrencyRow()).getByText("Not set")).toBeInTheDocument();
    // Read-only: no combobox/button offers to change it (Role's Select is the
    // only combobox on this page).
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
  });
});

describe("UserDetailPage — wallet display", () => {
  it("renders both IDR and USDT wallet balances on the Profile card", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByText("Rp500.000")).toBeInTheDocument();
    expect(screen.getByText("12.5 USDT")).toBeInTheDocument();
  });
});

describe("UserDetailPage — wallet adjustment currency", () => {
  it("defaults to IDR when no currency toggle is clicked", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("Amount (+ or −)"), "5");
    await user.type(screen.getByPlaceholderText("Reason (required)"), "goodwill");
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(await screen.findByRole("button", { name: "Credit wallet" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/users/7/wallet", { delta: "5", note: "goodwill", currency: "IDR" }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
    );
  });

  it("adjusts the USDT balance when the USDT toggle is selected", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "USDT" }));
    await user.type(screen.getByPlaceholderText("Amount (+ or −)"), "5");
    await user.type(screen.getByPlaceholderText("Reason (required)"), "top up");
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(await screen.findByRole("button", { name: "Credit wallet" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/users/7/wallet", { delta: "5", note: "top up", currency: "USDT" }, expect.objectContaining({ idempotencyKey: expect.any(String) })),
    );
  });
});

describe("UserDetailPage — wallet adjustment confirmation and retry", () => {
  /** The page loads, and reloads after a success, from a fresh Response each time. */
  function serveUser() {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }

  /** A response that reached the client, which is what ends a key's life. */
  function answerOk() {
    vi.mocked(apiPost).mockImplementationOnce(async (_path, _body, options) => {
      options?.onResponse?.(200);
      return { ok: true, newBalance: "500005" };
    });
  }

  function walletKeys(): string[] {
    return vi.mocked(apiPost).mock.calls.map((call) => (call[2] as { idempotencyKey: string }).idempotencyKey);
  }

  async function openPage() {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    serveUser();
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    return user;
  }

  async function fillForm(user: ReturnType<typeof userEvent.setup>, delta: string, note: string) {
    if (delta) await user.type(screen.getByPlaceholderText("Amount (+ or −)"), delta);
    if (note) await user.type(screen.getByPlaceholderText("Reason (required)"), note);
  }

  it("states the customer, currency, signed amount, direction and reason for a credit", async () => {
    const user = await openPage();
    await fillForm(user, "10.000", "goodwill");
    await user.click(screen.getByRole("button", { name: "Adjust" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Credit this wallet?")).toBeInTheDocument();
    expect(within(dialog).getByText("Andi Santoso")).toBeInTheDocument();
    expect(within(dialog).getByText("IDR")).toBeInTheDocument();
    expect(within(dialog).getByText("+Rp10.000")).toBeInTheDocument();
    expect(within(dialog).getByText("goodwill")).toBeInTheDocument();
  });

  it("states a debit as a debit with its minus sign, in USDT", async () => {
    const user = await openPage();
    await user.click(screen.getByRole("button", { name: "USDT" }));
    await fillForm(user, "-2.5", "correction");
    await user.click(screen.getByRole("button", { name: "Adjust" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Debit this wallet?")).toBeInTheDocument();
    expect(within(dialog).getByText("USDT")).toBeInTheDocument();
    expect(within(dialog).getByText("-2.5 USDT")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Debit wallet" })).toBeInTheDocument();
  });

  it("sends nothing when the confirmation is cancelled, and keeps the form filled", async () => {
    const user = await openPage();
    await fillForm(user, "5", "goodwill");
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Amount (+ or −)")).toHaveValue("5");
  });

  it.each([
    ["no amount", "", "goodwill", null],
    ["no reason", "5", "", null],
    ["a blank reason", "5", "   ", null],
    ["a zero amount", "0", "goodwill", /cannot be zero/i],
    ["an unreadable amount", "1.2.3", "goodwill", /written like/i],
  ])("offers no confirmation with %s", async (_label, delta, note, hint) => {
    const user = await openPage();
    await fillForm(user, delta, note);

    expect(screen.getByRole("button", { name: "Adjust" })).toBeDisabled();
    if (hint) expect(screen.getByText(hint)).toBeInTheDocument();
  });

  it.each([
    ["rupiah fractions", "IDR", "10,5"],
    ["a USDT amount that could mean one or a thousand", "USDT", "1.000"],
    ["more USDT decimals than the wallet holds", "USDT", "1.23456"],
  ])("offers no confirmation for %s, which the server would refuse", async (_label, currency, delta) => {
    const user = await openPage();
    if (currency === "USDT") await user.click(screen.getByRole("button", { name: "USDT" }));
    await fillForm(user, delta, "goodwill");

    expect(screen.getByRole("button", { name: "Adjust" })).toBeDisabled();
  });

  it("reuses the key after a network failure and keeps the form filled", async () => {
    const user = await openPage();
    await fillForm(user, "5", "goodwill");
    vi.mocked(apiPost).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(await screen.findByRole("button", { name: "Credit wallet" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByPlaceholderText("Amount (+ or −)")).toHaveValue("5");
    expect(screen.getByPlaceholderText("Reason (required)")).toHaveValue("goodwill");

    answerOk();
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(await screen.findByRole("button", { name: "Credit wallet" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));

    const [first, second] = walletKeys();
    expect(second).toBe(first);
  });

  it.each([
    ["no response", new TypeError("Failed to fetch")],
    ["a 502", Object.assign(new Error("/api/users/7/wallet responded 502"), { status: 502 })],
    ["a 429", Object.assign(new Error("error.rate_limited"), { status: 429 })],
  ])("reloads the customer and calls the outcome unknown after %s", async (_label, failure) => {
    // Spied rather than read from the DOM: sonner's toasts outlive a test's render.
    const showError = vi.spyOn(toast, "error");
    const user = await openPage();
    await fillForm(user, "5", "goodwill");
    const loads = vi.mocked(globalThis.fetch).mock.calls.length;
    vi.mocked(apiPost).mockRejectedValueOnce(failure);
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(await screen.findByRole("button", { name: "Credit wallet" }));

    await waitFor(() => expect(showError).toHaveBeenCalledTimes(1));
    expect(showError.mock.calls[0]?.[0]).toMatch(/outcome.*unknown.*ledger.*without changing anything/i);
    await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(loads + 1));
    expect(screen.getByPlaceholderText("Amount (+ or −)")).toHaveValue("5");
  });

  it("keeps an answered refusal's own message and does not call it unknown", async () => {
    const showError = vi.spyOn(toast, "error");
    const user = await openPage();
    await fillForm(user, "-5", "correction");
    vi.mocked(apiPost).mockRejectedValueOnce(Object.assign(new Error("Amount cannot be zero."), { status: 422 }));
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(await screen.findByRole("button", { name: "Debit wallet" }));

    await waitFor(() => expect(showError).toHaveBeenCalledTimes(1));
    expect(showError).toHaveBeenCalledWith("Amount cannot be zero.");
  });

  it("holds the key and says so plainly while the first attempt is still running", async () => {
    const user = await openPage();
    await fillForm(user, "5", "goodwill");
    vi.mocked(apiPost).mockImplementationOnce(async (_path, _body, options) => {
      options?.onResponse?.(409);
      throw Object.assign(new Error("idempotency_request_in_progress"), { status: 409 });
    });
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(await screen.findByRole("button", { name: "Credit wallet" }));

    expect(await screen.findByText(/still being processed/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    answerOk();
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(await screen.findByRole("button", { name: "Credit wallet" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));

    const [first, second] = walletKeys();
    expect(second).toBe(first);
  });

  it("mints a new key for the next adjustment after a success, even for the same values", async () => {
    const user = await openPage();
    await fillForm(user, "5", "goodwill");
    answerOk();
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(await screen.findByRole("button", { name: "Credit wallet" }));
    await waitFor(() => expect(screen.getByPlaceholderText("Amount (+ or −)")).toHaveValue(""));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await fillForm(user, "5", "goodwill");
    answerOk();
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.click(await screen.findByRole("button", { name: "Credit wallet" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));

    const [first, second] = walletKeys();
    expect(second).not.toBe(first);
  });

  it("sends once for a double click, and blocks the action until the answer arrives", async () => {
    const user = await openPage();
    await fillForm(user, "5", "goodwill");
    let finish: (value: unknown) => void = () => {};
    vi.mocked(apiPost).mockImplementationOnce((_path, _body, options) => new Promise((resolve) => {
      finish = (value) => {
        options?.onResponse?.(200);
        resolve(value);
      };
    }));
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await user.dblClick(await screen.findByRole("button", { name: "Credit wallet" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Processing…" })).toBeDisabled();

    finish({ ok: true, newBalance: "500005" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});

describe("UserDetailPage — wallet ledger currency column", () => {
  it("shows each ledger row's currency and its post-adjustment balance", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...USER_DETAIL,
          ledger: [
            { delta: "5.0000", balanceAfter: "505000.0000", currency: "IDR", reason: "admin_adjust", note: "goodwill", createdAt: "2026-07-01T00:00:00.000Z", createdAtDisplay: "2026-07-01" },
            { delta: "2.5000", balanceAfter: "15.0000", currency: "USDT", reason: "admin_adjust", note: "usdt credit", createdAt: "2026-07-02T00:00:00.000Z", createdAtDisplay: "2026-07-02" },
          ],
          ledgerTotal: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    expect(screen.getByRole("columnheader", { name: "Currency" })).toBeInTheDocument();
    expect(screen.getByText("505000.0000")).toBeInTheDocument();
    expect(screen.getByText("15.0000")).toBeInTheDocument();
    expect(screen.getByText("usdt credit")).toBeInTheDocument();
    expect(screen.getByText("2026-07-01")).toBeInTheDocument(); // createdAtDisplay
    expect(screen.getByText("2026-07-02")).toBeInTheDocument();
  });
});

describe("UserDetailPage — wallet ledger reason/note truncation (Task 4)", () => {
  it("truncates long Reason and Note values with a bounded width, keeping the full text in title", async () => {
    const longReason =
      "admin_adjust: manual correction for a duplicated wallet top-up that was processed twice by the payment gateway";
    const longNote =
      "Refunded after the customer reported a double-charge; verified against the gateway transaction log before approving the adjustment.";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...USER_DETAIL,
          ledger: [
            {
              delta: "5.0000",
              balanceAfter: "505000.0000",
              currency: "IDR",
              reason: longReason,
              note: longNote,
              createdAt: "2026-07-01T00:00:00.000Z",
              createdAtDisplay: "2026-07-01",
            },
          ],
          ledgerTotal: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    const reasonEl = await screen.findByTitle(longReason);
    expect(reasonEl).toHaveClass("truncate");
    expect(reasonEl.className).toMatch(/max-w-\[240px\]/);

    const noteEl = screen.getByTitle(longNote);
    expect(noteEl).toHaveClass("truncate");
    expect(noteEl.className).toMatch(/max-w-\[240px\]/);
  });

  it("does not set a title on the Note cell when there is no note", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...USER_DETAIL,
          ledger: [
            {
              delta: "5.0000",
              balanceAfter: "505000.0000",
              currency: "IDR",
              reason: "admin_adjust",
              note: null,
              createdAt: "2026-07-01T00:00:00.000Z",
              createdAtDisplay: "2026-07-01",
            },
          ],
          ledgerTotal: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    const noteEl = await screen.findByText("—", { selector: "span.text-xs" });
    expect(noteEl).not.toHaveAttribute("title");
  });
});

describe("UserDetailPage — support tickets", () => {
  it("renders a populated Support Tickets card with subject/status/date columns", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...USER_DETAIL,
          tickets: [
            { id: 101, message: "Order not received", status: "OPEN", createdAt: "2026-07-15T10:00:00.000Z", createdAtDisplay: "2026-07-15" },
            { id: 102, message: "Payment issue", status: "CLOSED", createdAt: "2026-07-16T14:30:00.000Z", createdAtDisplay: "2026-07-16" },
          ],
          ticketsTotal: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    expect(screen.getByText("Support Tickets (2)")).toBeInTheDocument();
    expect(screen.getByText("Order not received")).toBeInTheDocument();
    expect(screen.getByText("Payment issue")).toBeInTheDocument();
    // Check column headers exist (multiple Status headers are OK as long as they're in different tables)
    const columnHeaders = screen.getAllByRole("columnheader", { name: "Subject" });
    expect(columnHeaders.length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-07-15")).toHaveLength(1); // only in tickets
  });
});

describe("UserDetailPage — support ticket subject truncation (Task 4)", () => {
  it("truncates a long ticket message in the Subject column, keeping the full text in title", async () => {
    const longMessage =
      "My order was marked as delivered but I never received the product key, and the support bot did not respond to my follow-up messages for two days.";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...USER_DETAIL,
          tickets: [
            { id: 101, message: longMessage, status: "OPEN", createdAt: "2026-07-15T10:00:00.000Z", createdAtDisplay: "2026-07-15" },
          ],
          ticketsTotal: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    const subjectEl = await screen.findByTitle(longMessage);
    expect(subjectEl).toHaveClass("truncate");
    expect(subjectEl.className).toMatch(/max-w-\[320px\]/);
  });
});

describe("UserDetailPage — real totals, not .length of a capped list (T3)", () => {
  it("shows the server's real total in each card title, and a capped note when the list was truncated", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...USER_DETAIL,
          orders: [
            { id: 1, orderCode: "ORD-1", status: "DELIVERED", totalIdr: "Rp10.000", createdAt: "2026-07-01T00:00:00.000Z", createdAtDisplay: "2026-07-01" },
          ],
          ordersTotal: 47, // real total far beyond the capped page of 1 shown here
          tickets: [
            { id: 101, message: "Order not received", status: "OPEN", createdAt: "2026-07-15T10:00:00.000Z", createdAtDisplay: "2026-07-15" },
          ],
          ticketsTotal: 3,
          ledger: [
            { delta: "5.0000", balanceAfter: "5.0000", currency: "IDR", reason: "admin_adjust", note: null, createdAt: "2026-07-01T00:00:00.000Z", createdAtDisplay: "2026-07-01" },
          ],
          ledgerTotal: 60,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    // Titles show the real server totals, never the capped array's .length.
    expect(screen.getByText("Recent Orders (47)")).toBeInTheDocument();
    expect(screen.getByText("Support Tickets (3)")).toBeInTheDocument();
    expect(screen.getByText("Wallet Ledger (60)")).toBeInTheDocument();

    // Each of the three capped cards explains that only the most recent row is shown.
    expect(screen.getAllByText("Showing the 1 most recent.")).toHaveLength(3);
  });
});

describe("UserDetailPage — anchor navigation", () => {
  it("renders both #ledger and #tickets anchors for deep linking", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const { container } = render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    const ledgerAnchor = container.querySelector("#ledger");
    const ticketsAnchor = container.querySelector("#tickets");

    expect(ledgerAnchor).toBeInTheDocument();
    expect(ticketsAnchor).toBeInTheDocument();
  });
});

describe("UserDetailPage loading", () => {
  it("shows a busy page skeleton, not a bare Loading… line, while the customer loads", () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    render(<UserDetailPage />, { wrapper: Wrapper });
    expect(screen.getByRole("status", { name: "Loading customer" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});
