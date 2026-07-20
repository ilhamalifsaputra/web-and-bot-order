import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StockProductPage, maskCredential } from "./StockProductPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/stock/10"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/stock/:productId" element={children} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const STOCK_PRODUCT_DATA = {
  product: {
    id: 10,
    name: "1 Month",
    isActive: true,
    broadcastOnRestock: false,
    product: { id: 1, name: "CapCut Pro", category: { name: "Apps" } },
  },
  items: [
    { id: 101, status: "AVAILABLE", note: null, credentials: "buyer@mail.com:Pass123", createdAt: "2026-01-01T00:00:00.000Z", createdAtDisplay: "2026-01-01" },
  ],
  available: 1,
  waiting: 0,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("StockProductPage", () => {
  it("shows stock product detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(STOCK_PRODUCT_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
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
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(STOCK_PRODUCT_DATA), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());
    const link = screen.getByRole("link", { name: /download credentials/i });
    expect(link).toHaveAttribute("href", "/api/stock/10/download");
  });

  it("selects an item and bulk marks it dead", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(STOCK_PRODUCT_DATA), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /select stock item 101/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...STOCK_PRODUCT_DATA, items: [{ ...STOCK_PRODUCT_DATA.items[0], status: "DEAD" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark selected dead" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/stock/10/bulk-dead",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: [101] }) }),
      ),
    );
  });

  it("marks a single item dead after confirming", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(STOCK_PRODUCT_DATA), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Mark Dead" }));
    const dialog = await screen.findByRole("dialog");

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...STOCK_PRODUCT_DATA, items: [{ ...STOCK_PRODUCT_DATA.items[0], status: "DEAD" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark Dead" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/stock/item/101/dead", expect.objectContaining({ method: "POST" })),
    );
  });

  it("edits a stock item's note", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(STOCK_PRODUCT_DATA), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Edit Note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note for stock item 101" }), { target: { value: "checked ok" } });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...STOCK_PRODUCT_DATA, items: [{ ...STOCK_PRODUCT_DATA.items[0], note: "checked ok" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/stock/item/101/note",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ note: "checked ok" }) }),
      ),
    );
  });

  it("splits items into Available/Sold/Dead tabs and scopes the download link to Available", async () => {
    const mixedData = {
      ...STOCK_PRODUCT_DATA,
      items: [
        { id: 101, status: "AVAILABLE", note: null, credentials: "a@mail.com:Pw1", createdAt: "2026-01-01T00:00:00.000Z", createdAtDisplay: "2026-01-01" },
        { id: 102, status: "SOLD", note: null, credentials: "b@mail.com:Pw2", createdAt: "2026-01-02T00:00:00.000Z", createdAtDisplay: "2026-01-02" },
        { id: 103, status: "RESERVED", note: null, credentials: "c@mail.com:Pw3", createdAt: "2026-01-03T00:00:00.000Z", createdAtDisplay: "2026-01-03" },
        { id: 104, status: "DEAD", note: null, credentials: "d@mail.com:Pw4", createdAt: "2026-01-04T00:00:00.000Z", createdAtDisplay: "2026-01-04" },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mixedData), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Available (1)" })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Sold (2)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Dead (1)" })).toBeInTheDocument();

    // Available tab is the default view: item 101 visible, download link shown.
    expect(screen.getByText("101")).toBeInTheDocument();
    expect(screen.queryByText("102")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download credentials/i })).toBeInTheDocument();

    // Switch to Sold: both the SOLD and RESERVED rows show up there; download link disappears.
    // Radix Tabs selects on mousedown (or focus), not click — see Tabs.Trigger's onMouseDown handler.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Sold (2)" }));
    expect(await screen.findByText("102")).toBeInTheDocument();
    expect(screen.getByText("103")).toBeInTheDocument();
    expect(screen.queryByText("101")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download credentials/i })).not.toBeInTheDocument();

    // Switch to Dead: only the DEAD row shows up.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Dead (1)" }));
    expect(await screen.findByText("104")).toBeInTheDocument();
    expect(screen.queryByText("102")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download credentials/i })).not.toBeInTheDocument();

    // Back to Available: download link reappears.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Available (1)" }));
    expect(await screen.findByRole("link", { name: /download credentials/i })).toBeInTheDocument();
  });

  it("toggles the restock broadcast checkbox", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(STOCK_PRODUCT_DATA), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    const checkbox = screen.getByRole("checkbox", {
      name: /broadcast to all customers when i add stock to this product/i,
    });
    expect(checkbox).not.toBeChecked();

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, broadcastOnRestock: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...STOCK_PRODUCT_DATA, product: { ...STOCK_PRODUCT_DATA.product, broadcastOnRestock: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/stock/10/broadcast",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ enabled: true }) }),
      ),
    );
  });

  it("masks the account credential until the row is revealed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(STOCK_PRODUCT_DATA), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    // Masked by default: the prefix shows, the full credential does not.
    expect(screen.getByText("buyer@mail••••••••")).toBeInTheDocument();
    expect(screen.queryByText("buyer@mail.com:Pass123")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show account for stock item 101" }));
    expect(screen.getByText("buyer@mail.com:Pass123")).toBeInTheDocument();

    // The same button now hides it again.
    fireEvent.click(screen.getByRole("button", { name: "Hide account for stock item 101" }));
    expect(screen.queryByText("buyer@mail.com:Pass123")).not.toBeInTheDocument();
    expect(screen.getByText("buyer@mail••••••••")).toBeInTheDocument();
  });

  it("copies the full credential even while it is masked", async () => {
    // See VouchersPage.test.tsx — user-event installs the clipboard stub, so we
    // spy on its writeText rather than pre-mocking navigator.clipboard.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(STOCK_PRODUCT_DATA), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());

    const copyButton = screen.getByRole("button", { name: "Copy account for stock item 101" });
    await user.click(copyButton);

    expect(writeText).toHaveBeenCalledWith("buyer@mail.com:Pass123");
    await waitFor(() => expect(copyButton.querySelector("svg.lucide-check")).toBeInTheDocument());
  });

  it("clears the revealed account when switching tabs", async () => {
    const mixedData = {
      ...STOCK_PRODUCT_DATA,
      items: [
        { id: 101, status: "AVAILABLE", note: null, credentials: "a@mail.com:Pw1", createdAt: "2026-01-01T00:00:00.000Z", createdAtDisplay: "2026-01-01" },
        { id: 102, status: "SOLD", note: null, credentials: "b@mail.com:Pw2", createdAt: "2026-01-02T00:00:00.000Z", createdAtDisplay: "2026-01-02" },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mixedData), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<StockProductPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Available (1)" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Show account for stock item 101" }));
    expect(screen.getByText("a@mail.com:Pw1")).toBeInTheDocument();

    // Radix Tabs selects on mousedown, not click.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Sold (1)" }));
    expect(await screen.findByText("b@mail.com••••")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Available (1)" }));
    expect(await screen.findByText("a@mail.com••••")).toBeInTheDocument();
    expect(screen.queryByText("a@mail.com:Pw1")).not.toBeInTheDocument();
  });

  describe("maskCredential", () => {
    it("keeps a short prefix and caps the dot run", () => {
      expect(maskCredential("buyer@mail.com:Pass123")).toBe("buyer@mail••••••••");
      expect(maskCredential("a@mail.com:Pw1")).toBe("a@mail.com••••");
      expect(maskCredential("short")).toBe("short");
      expect(maskCredential("")).toBe("—");
    });
  });
});
