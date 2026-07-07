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
});
