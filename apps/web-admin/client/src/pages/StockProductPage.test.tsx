import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { StockProductPage } from "./StockProductPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/stock/10"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/stock/:productId" element={children} />
        </Routes>
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const PRODUCT = {
  id: 10,
  name: "1 Month",
  isActive: true,
  broadcastOnRestock: false,
  product: { id: 1, name: "CapCut Pro", category: { name: "Apps" } },
};

// The server now returns only the CURRENT tab's rows in `items` (paginated,
// or search-matched), plus a `statusCounts` aggregate across all statuses
// that's independent of which tab/page is being viewed — see Tasks 1/2.
const STOCK_PRODUCT_DATA = {
  product: PRODUCT,
  items: [
    { id: 101, status: "AVAILABLE", note: null, credentials: "••••••••", createdAt: "2026-01-01T00:00:00.000Z", createdAtDisplay: "2026-01-01" },
  ],
  statusCounts: { available: 1, reserved: 0, sold: 0, dead: 0 },
  total: 1,
  waiting: 0,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("StockProductPage", () => {
  it("shows stock product detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    // Wait for data — StatusBadge renders "Available" (title-cased) in the status td
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());
    // Item id appears in its own td
    expect(screen.getByText("101")).toBeInTheDocument();
    expect(screen.getByText("2026-01-01")).toBeInTheDocument(); // createdAtDisplay
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("shows a download credentials link pointing at the download endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());
    const link = screen.getByRole("link", { name: /download credentials/i });
    expect(link).toHaveAttribute("href", "/api/stock/10/download");
  });

  it("selects an item and bulk marks it dead", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /select stock item 101/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mark selected dead" }));
    const dialog = await screen.findByRole("dialog");

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true, count: 1 }));
    // The mutation's onSuccess invalidates ["stock", productId], which
    // matches (by prefix) the currently-active ["stock", "10", "available",
    // 1, ""] query and refetches it — item 101 no longer belongs there once dead.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ...STOCK_PRODUCT_DATA, items: [], statusCounts: { available: 0, reserved: 0, sold: 0, dead: 1 }, total: 0 }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark Dead" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/stock/10/bulk-dead",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: [101] }) }),
      ),
    );
  });

  it("bulk deletes selected items and shows success message when all are deleted", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /select stock item 101/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true, count: 1, skipped: 0 }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ...STOCK_PRODUCT_DATA, items: [], statusCounts: { available: 0, reserved: 0, sold: 0, dead: 0 }, total: 0 }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/stock/10/bulk-delete",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: [101] }) }),
      ),
    );
    expect(await screen.findByText("1 item(s) deleted.")).toBeInTheDocument();
  });

  it("bulk deletes items and shows skip explanation when some are skipped", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // The "available" tab's page only ever contains AVAILABLE rows now — the
    // SOLD row that used to ride along in one mixed `items` array is instead
    // represented purely via `statusCounts.sold`, which still has to drive
    // the "Sold" tab label correctly even though its row is never fetched here.
    const availableTabData = {
      ...STOCK_PRODUCT_DATA,
      items: [
        { id: 101, status: "AVAILABLE", note: null, credentials: "a@mail.com:Pw1", createdAt: "2026-01-01T00:00:00.000Z", createdAtDisplay: "2026-01-01" },
        { id: 102, status: "AVAILABLE", note: null, credentials: "b@mail.com:Pw2", createdAt: "2026-01-02T00:00:00.000Z", createdAtDisplay: "2026-01-02" },
      ],
      statusCounts: { available: 2, reserved: 0, sold: 1, dead: 0 },
      total: 2,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(availableTabData));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Available (2)" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /select stock item 101/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /select stock item 102/i }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true, count: 2, skipped: 1 }));
    // Both AVAILABLE rows are gone; the skipped SOLD row was never part of
    // this tab's page to begin with, so the refetched "available" page is empty.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ...availableTabData, items: [], statusCounts: { available: 0, reserved: 0, sold: 1, dead: 0 }, total: 0 }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/stock/10/bulk-delete",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: [101, 102] }) }),
      ),
    );
    expect(await screen.findByText("2 item(s) deleted. 1 skipped (sold or linked to an order).")).toBeInTheDocument();
  });

  it("selects all items on the page via the header checkbox", async () => {
    const twoAvailable = {
      ...STOCK_PRODUCT_DATA,
      items: [
        { id: 101, status: "AVAILABLE", note: null, credentials: "a@mail.com:Pw1", createdAt: "2026-01-01T00:00:00.000Z", createdAtDisplay: "2026-01-01" },
        { id: 102, status: "AVAILABLE", note: null, credentials: "b@mail.com:Pw2", createdAt: "2026-01-02T00:00:00.000Z", createdAtDisplay: "2026-01-02" },
      ],
      statusCounts: { available: 2, reserved: 0, sold: 0, dead: 0 },
      total: 2,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(twoAvailable));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Available (2)" })).toBeInTheDocument());

    const selectAll = screen.getByRole("checkbox", { name: "Select all stock items on this page" });
    fireEvent.click(selectAll);
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /select stock item 101/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /select stock item 102/i })).toBeChecked();

    fireEvent.click(selectAll);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("marks a single item dead after confirming", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for stock item 101" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Mark Dead"));

    const dialog = await screen.findByRole("dialog");

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ...STOCK_PRODUCT_DATA, items: [], statusCounts: { available: 0, reserved: 0, sold: 0, dead: 1 }, total: 0 }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark Dead" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/stock/item/101/dead", expect.objectContaining({ method: "POST" })),
    );
  });

  it("deletes a single item after confirming", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for stock item 101" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Delete"));

    const dialog = await screen.findByRole("dialog");

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ...STOCK_PRODUCT_DATA, items: [], statusCounts: { available: 0, reserved: 0, sold: 0, dead: 0 }, total: 0 }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/stock/item/101/delete", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findByText("Stock item deleted.")).toBeInTheDocument();
  });

  it("edits a stock item's note", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for stock item 101" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Edit Note"));

    fireEvent.change(screen.getByRole("textbox", { name: "Note for stock item 101" }), { target: { value: "checked ok" } });

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ...STOCK_PRODUCT_DATA, items: [{ ...STOCK_PRODUCT_DATA.items[0], note: "checked ok" }] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/stock/item/101/note",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ note: "checked ok" }) }),
      ),
    );
  });

  it("switches tabs with a real server refetch per tab and scopes the download link to Available", async () => {
    // Each tab is now its own fetch (server-side pagination per tab, Tasks
    // 1/2) instead of one combined payload sliced client-side — statusCounts
    // stays constant across all three responses since it's a fixed aggregate
    // independent of which tab is being viewed.
    const statusCounts = { available: 1, reserved: 1, sold: 1, dead: 1 };
    const availableResp = {
      product: PRODUCT,
      items: [{ id: 101, status: "AVAILABLE", note: null, credentials: "a@mail.com:Pw1", createdAt: "2026-01-01T00:00:00.000Z", createdAtDisplay: "2026-01-01" }],
      statusCounts,
      total: 1,
      waiting: 0,
    };
    const soldResp = {
      product: PRODUCT,
      items: [
        { id: 102, status: "SOLD", note: null, credentials: "b@mail.com:Pw2", createdAt: "2026-01-02T00:00:00.000Z", createdAtDisplay: "2026-01-02" },
        { id: 103, status: "RESERVED", note: null, credentials: "c@mail.com:Pw3", createdAt: "2026-01-03T00:00:00.000Z", createdAtDisplay: "2026-01-03" },
      ],
      statusCounts,
      total: 2,
      waiting: 0,
    };
    const deadResp = {
      product: PRODUCT,
      items: [{ id: 104, status: "DEAD", note: null, credentials: "d@mail.com:Pw4", createdAt: "2026-01-04T00:00:00.000Z", createdAtDisplay: "2026-01-04" }],
      statusCounts,
      total: 1,
      waiting: 0,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(availableResp));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Available (1)" })).toBeInTheDocument());
    // "Sold" groups SOLD + RESERVED (statusCounts.sold + statusCounts.reserved = 1 + 1).
    expect(screen.getByRole("tab", { name: "Sold (2)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Dead (1)" })).toBeInTheDocument();

    // Available tab is the default view: item 101 visible, download link shown.
    expect(screen.getByText("101")).toBeInTheDocument();
    expect(screen.queryByText("102")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download credentials/i })).toBeInTheDocument();

    // Switch to Sold: this is a brand-new query key (tab changed), so it
    // triggers a fresh fetch — queue its response before clicking.
    // Radix Tabs selects on mousedown (or focus), not click — see Tabs.Trigger's onMouseDown handler.
    fetchSpy.mockResolvedValueOnce(jsonResponse(soldResp));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Sold (2)" }));
    expect(await screen.findByText("102")).toBeInTheDocument();
    expect(screen.getByText("103")).toBeInTheDocument();
    expect(screen.queryByText("101")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download credentials/i })).not.toBeInTheDocument();

    // Switch to Dead: another new query key, another fetch.
    fetchSpy.mockResolvedValueOnce(jsonResponse(deadResp));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Dead (1)" }));
    expect(await screen.findByText("104")).toBeInTheDocument();
    expect(screen.queryByText("102")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download credentials/i })).not.toBeInTheDocument();

    // Back to Available: the query result is still fresh (staleTime), so no
    // extra fetch is queued or needed — it renders straight from cache.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Available (1)" }));
    expect(await screen.findByRole("link", { name: /download credentials/i })).toBeInTheDocument();
    expect(await screen.findByText("101")).toBeInTheDocument();
  });

  it("ticks the restock broadcast checkbox optimistically, before the POST resolves", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    const checkbox = screen.getByRole("checkbox", {
      name: /broadcast to all customers when i add stock to this product/i,
    });
    expect(checkbox).not.toBeChecked();

    // The POST response never resolves during this assertion window — the
    // checkbox must already read checked from the optimistic cache patch,
    // not from a round-trip.
    let resolvePost!: (value: Response) => void;
    fetchSpy.mockReturnValueOnce(new Promise<Response>((resolve) => { resolvePost = resolve; }));
    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox).toBeChecked());
    expect(checkbox).toBeDisabled();

    resolvePost(jsonResponse({ ok: true, broadcastOnRestock: true }));

    await waitFor(() => expect(checkbox).not.toBeDisabled());
    expect(checkbox).toBeChecked();

    // Exactly one fetch beyond the initial page load — no invalidation refetch.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/stock/10/broadcast",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ enabled: true }) }),
    );
  });

  it("rolls the broadcast checkbox back and shows a toast when the POST is rejected", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    const checkbox = screen.getByRole("checkbox", {
      name: /broadcast to all customers when i add stock to this product/i,
    });
    expect(checkbox).not.toBeChecked();

    // The rejection settles too fast to reliably observe the transient
    // optimistic "checked" state here (that's covered by the optimistic-tick
    // test above via a manually held-open promise) — what matters for a
    // rollback is that it lands back at unchecked, with an error toast.
    fetchSpy.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(checkbox).not.toBeDisabled();
    expect(await screen.findByText("network")).toBeInTheDocument();
  });

  it("masks the account credential until the row is revealed, via an audited server round-trip", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    // Masked by default — the list payload never carries the real value.
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(screen.queryByText("buyer@mail.com:Pass123")).not.toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true, credentials: "buyer@mail.com:Pass123" }));
    fireEvent.click(screen.getByRole("button", { name: "Show account for stock item 101" }));
    expect(await screen.findByText("buyer@mail.com:Pass123")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/stock/item/101/reveal",
      expect.objectContaining({ method: "POST" }),
    );

    // The same button now hides it again — no extra fetch needed to hide.
    const revealCallCount = fetchSpy.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Hide account for stock item 101" }));
    expect(screen.queryByText("buyer@mail.com:Pass123")).not.toBeInTheDocument();
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(fetchSpy.mock.calls.length).toBe(revealCallCount);
  });

  it("copies the full credential, revealing it via the server first", async () => {
    // See VouchersPage.test.tsx — user-event installs the clipboard stub, so we
    // spy on its writeText rather than pre-mocking navigator.clipboard.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true, credentials: "buyer@mail.com:Pass123" }));
    const copyButton = screen.getByRole("button", { name: "Copy account for stock item 101" });
    await user.click(copyButton);

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/stock/item/101/reveal",
      expect.objectContaining({ method: "POST" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("buyer@mail.com:Pass123"));
    await waitFor(() => expect(copyButton.querySelector("svg.lucide-check")).toBeInTheDocument());
  });

  it("clears the revealed account when switching tabs, re-revealing (and re-auditing) on return", async () => {
    const statusCounts = { available: 1, reserved: 0, sold: 1, dead: 0 };
    const availableResp = {
      product: PRODUCT,
      items: [{ id: 101, status: "AVAILABLE", note: null, credentials: "••••••••", createdAt: "2026-01-01T00:00:00.000Z", createdAtDisplay: "2026-01-01" }],
      statusCounts,
      total: 1,
      waiting: 0,
    };
    const soldResp = {
      product: PRODUCT,
      items: [{ id: 102, status: "SOLD", note: null, credentials: "••••••••", createdAt: "2026-01-02T00:00:00.000Z", createdAtDisplay: "2026-01-02" }],
      statusCounts,
      total: 1,
      waiting: 0,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(availableResp));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Available (1)" })).toBeInTheDocument());

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true, credentials: "a@mail.com:Pw1" }));
    fireEvent.click(screen.getByRole("button", { name: "Show account for stock item 101" }));
    expect(await screen.findByText("a@mail.com:Pw1")).toBeInTheDocument();

    // Radix Tabs selects on mousedown, not click. New tab, new query key, new fetch.
    fetchSpy.mockResolvedValueOnce(jsonResponse(soldResp));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Sold (1)" }));
    expect(await screen.findByText("••••••••")).toBeInTheDocument();
    expect(screen.queryByText("a@mail.com:Pw1")).not.toBeInTheDocument();

    // Back to Available: still fresh in cache (staleTime), so this renders
    // without another network round-trip — and re-masked, since revealedId
    // was cleared on tab change.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Available (1)" }));
    expect(await screen.findByText("••••••••")).toBeInTheDocument();
  });

  it("searches within the active tab, showing the match count and clearing back to the paginated view", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    // Search mode ignores `page` server-side and reports the match count via
    // `total` (Task 2) — capped at 200 matches, not relevant at this scale.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ...STOCK_PRODUCT_DATA,
        items: [{ id: 101, status: "AVAILABLE", note: null, credentials: "a@mail.com:Pw1", createdAt: "2026-01-01T00:00:00.000Z", createdAtDisplay: "2026-01-01" }],
        total: 1,
      }),
    );
    await user.type(screen.getByPlaceholderText("Search this tab's accounts…"), "a@mail.com{Enter}");

    expect(await screen.findByText('Showing 1 result for "a@mail.com"')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith("/api/stock/10?tab=available&q=a%40mail.com", { credentials: "include" });
    // Pagination is hidden while a search is active — search results aren't paginated.
    expect(screen.queryByLabelText("Next page")).not.toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(jsonResponse(STOCK_PRODUCT_DATA));
    await user.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/stock/10?tab=available&page=1", { credentials: "include" }),
    );
    expect(screen.queryByText(/Showing 1 result/)).not.toBeInTheDocument();
  });

  it("changes page via the shared pagination control", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ...STOCK_PRODUCT_DATA, total: 120 }));
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ...STOCK_PRODUCT_DATA,
        items: [{ ...STOCK_PRODUCT_DATA.items[0], id: 201 }],
        total: 120,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(await screen.findByText("201")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith("/api/stock/10?tab=available&page=2", { credentials: "include" });
  });
});
