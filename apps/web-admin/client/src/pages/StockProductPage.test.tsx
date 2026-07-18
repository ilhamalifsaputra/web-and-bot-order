import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StockProductPage } from "./StockProductPage";

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
    { id: 101, status: "AVAILABLE", note: null, createdAt: "2026-01-01T00:00:00.000Z", createdAtDisplay: "2026-01-01" },
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
        { id: 101, status: "AVAILABLE", note: null, createdAt: "2026-01-01T00:00:00.000Z", createdAtDisplay: "2026-01-01" },
        { id: 102, status: "SOLD", note: null, createdAt: "2026-01-02T00:00:00.000Z", createdAtDisplay: "2026-01-02" },
        { id: 103, status: "RESERVED", note: null, createdAt: "2026-01-03T00:00:00.000Z", createdAtDisplay: "2026-01-03" },
        { id: 104, status: "DEAD", note: null, createdAt: "2026-01-04T00:00:00.000Z", createdAtDisplay: "2026-01-04" },
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
});
