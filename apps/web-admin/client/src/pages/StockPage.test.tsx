import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StockPage } from "./StockPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const DENOM_HEALTHY = {
  id: 10,
  name: "1 Month",
  isActive: true,
  product: { id: 1, name: "CapCut Pro", category: { id: 1, name: "Apps" } },
};
const DENOM_LOW = {
  id: 20,
  name: "3 Months",
  isActive: true,
  product: { id: 2, name: "Netflix Premium", category: { id: 2, name: "Streaming" } },
};
const DENOM_OUT = {
  id: 30,
  name: "1 Year",
  isActive: true,
  product: { id: 3, name: "Spotify", category: { id: 2, name: "Streaming" } },
};

const STOCK_DATA = {
  denominations: [DENOM_HEALTHY, DENOM_LOW, DENOM_OUT],
  counts: {
    "10": { available: 8, reserved: 1, sold: 1, dead: 0 },
    "20": { available: 3, reserved: 0, sold: 7, dead: 0 },
    "30": { available: 0, reserved: 0, sold: 5, dead: 0 },
  },
  waiting: { "30": 2 },
};

function mockStock(data: unknown = STOCK_DATA) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

/** A StatTile's numeric value, scoped to a given container so it can't be
 *  confused with the same label text appearing as a Select option or a row's
 *  StatusBadge elsewhere on the page (e.g. "Low Stock" is both a KPI label
 *  and a badge string). */
function tileValue(container: HTMLElement, label: string): string | null {
  const card = within(container).getByText(label).closest('[data-slot="card"]');
  return card?.querySelector(".font-display")?.textContent ?? null;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select uses pointer-capture APIs jsdom doesn't implement.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("StockPage", () => {
  it("shows denomination rows", async () => {
    mockStock();
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());
    expect(screen.getByText("CapCut Pro")).toBeInTheDocument();
    expect(screen.getByText("3 Months")).toBeInTheDocument();
    expect(screen.getByText("1 Year")).toBeInTheDocument();
  });

  it("shows KPI tiles matching the loaded counts", async () => {
    mockStock();
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());

    // Scope to the KPI grid (found via the collision-free "Total SKU" label)
    // so "Low Stock"/"Out of Stock" don't ambiguously match a row's badge too.
    const kpiRow = screen.getByText("Total SKU").closest('[data-slot="card"]')!.parentElement as HTMLElement;
    expect(tileValue(kpiRow, "Total SKU")).toBe("3");
    expect(tileValue(kpiRow, "Available")).toBe("2");
    expect(tileValue(kpiRow, "Low Stock")).toBe("1");
    expect(tileValue(kpiRow, "Out of Stock")).toBe("1");
  });

  it("shows a status badge and the ready/total ratio for every row", async () => {
    mockStock();
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());

    const healthyRow = screen.getByText("1 Month").closest("tr")!;
    expect(within(healthyRow).getByText("In Stock")).toBeInTheDocument();
    expect(within(healthyRow).getByText("8 / 10 Ready")).toBeInTheDocument();

    const lowRow = screen.getByText("3 Months").closest("tr")!;
    expect(within(lowRow).getByText("Low Stock")).toBeInTheDocument();
    expect(within(lowRow).getByText("3 / 10 Ready")).toBeInTheDocument();

    const outRow = screen.getByText("1 Year").closest("tr")!;
    expect(within(outRow).getByText("Out Of Stock")).toBeInTheDocument();
    expect(within(outRow).getByText("0 / 5 Ready")).toBeInTheDocument();
  });

  it("filters by category", async () => {
    const user = userEvent.setup();
    mockStock();
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());

    const categorySelect = screen.getByText("All categories").closest('[role="combobox"]')!;
    await user.click(categorySelect);
    await user.click(await screen.findByRole("option", { name: "Streaming" }));

    await waitFor(() => expect(screen.queryByText("1 Month")).not.toBeInTheDocument());
    expect(screen.getByText("3 Months")).toBeInTheDocument();
    expect(screen.getByText("1 Year")).toBeInTheDocument();
  });

  it("filters by availability", async () => {
    const user = userEvent.setup();
    mockStock();
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());

    const availabilitySelect = screen.getByText("All").closest('[role="combobox"]')!;
    await user.click(availabilitySelect);
    await user.click(await screen.findByRole("option", { name: "Out of Stock" }));

    await waitFor(() => expect(screen.queryByText("1 Month")).not.toBeInTheDocument());
    expect(screen.queryByText("3 Months")).not.toBeInTheDocument();
    expect(screen.getByText("1 Year")).toBeInTheDocument();
  });

  it("sorts by lowest available first", async () => {
    const user = userEvent.setup();
    mockStock();
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());

    const sortSelect = screen.getByText("Name A–Z").closest('[role="combobox"]')!;
    await user.click(sortSelect);
    await user.click(await screen.findByRole("option", { name: "Low Stock First" }));

    const dataRows = screen
      .getAllByRole("row")
      .map((r) => r.textContent ?? "")
      .filter((text) => /1 Month|3 Months|1 Year/.test(text));
    expect(dataRows[0]).toContain("1 Year"); // 0 available
    expect(dataRows[1]).toContain("3 Months"); // 3 available
    expect(dataRows[2]).toContain("1 Month"); // 8 available
  });

  it("row overflow menu offers View and Download Credentials when stock is available", async () => {
    const user = userEvent.setup();
    mockStock();
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for 1 Month" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("View")).toBeInTheDocument();
    expect(within(menu).getByText("Download Credentials")).toBeInTheDocument();
  });

  it("row overflow menu hides Download Credentials when the row is out of stock", async () => {
    const user = userEvent.setup();
    mockStock();
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Year")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for 1 Year" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("View")).toBeInTheDocument();
    expect(within(menu).queryByText("Download Credentials")).not.toBeInTheDocument();
  });

  it("shows an Export CSV link pointing at the export endpoint", async () => {
    mockStock();
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /export csv/i })).toHaveAttribute("href", "/api/stock/export");
  });

  it("shows a 'Go to Catalog' CTA when there are no denominations at all", async () => {
    mockStock({ denominations: [], counts: {}, waiting: {} });
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no denominations found/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Go to Catalog" })).toBeInTheDocument();
  });

  it("shows Clear Filters (not Go to Catalog) when a filter narrows the list to nothing", async () => {
    mockStock();
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/filter by denomination, product, or category/i), {
      target: { value: "no-such-item-xyz" },
    });

    await waitFor(() => expect(screen.getByText(/no denominations found/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Clear Filters" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to Catalog" })).not.toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
