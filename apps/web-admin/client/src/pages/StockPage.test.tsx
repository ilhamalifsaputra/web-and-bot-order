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
  deliveryType: "auto",
  product: { id: 1, name: "CapCut Pro", category: { id: 1, name: "Apps" } },
};
const DENOM_LOW = {
  id: 20,
  name: "3 Months",
  isActive: true,
  deliveryType: "auto",
  product: { id: 2, name: "Netflix Premium", category: { id: 2, name: "Streaming" } },
};
const DENOM_OUT = {
  id: 30,
  name: "1 Year",
  isActive: true,
  deliveryType: "auto",
  product: { id: 3, name: "Spotify", category: { id: 2, name: "Streaming" } },
};

const STOCK_DATA = {
  denominations: [DENOM_HEALTHY, DENOM_LOW, DENOM_OUT],
  counts: {
    // Threshold is 3 (STOCK_DATA's lowStockThreshold below) — 8 is healthy,
    // 3 sits exactly at the threshold (low, per the shared `<=` rule), 0 is out.
    "10": { available: 8, reserved: 1, sold: 1, dead: 0 },
    "20": { available: 3, reserved: 0, sold: 7, dead: 0 },
    "30": { available: 0, reserved: 0, sold: 5, dead: 0 },
  },
  waiting: { "30": 2 },
  lowStockThreshold: 3,
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
    expect(tileValue(kpiRow, "In stock (SKUs)")).toBe("2");
    expect(tileValue(kpiRow, "Low Stock")).toBe("1");
    expect(tileValue(kpiRow, "Out of Stock")).toBe("1");
  });

  it("shows a loading skeleton in the KPI tiles, never a real-looking 0, while the fetch is in flight", async () => {
    let resolveFetch!: (r: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
      new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    render(<StockPage />, { wrapper: Wrapper });

    const kpiRow = screen.getByText("Total SKU").closest('[data-slot="card"]')!.parentElement as HTMLElement;
    expect(tileValue(kpiRow, "Total SKU")).toBeNull();
    expect(screen.queryByText("0", { selector: ".font-display" })).not.toBeInTheDocument();

    resolveFetch(new Response(JSON.stringify(STOCK_DATA), { status: 200, headers: { "Content-Type": "application/json" } }));
    await waitFor(() => expect(tileValue(kpiRow, "Total SKU")).toBe("3"));
  });

  it("shows a status badge and the ready-count for every row (S-UI: no percentage bar)", async () => {
    mockStock();
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());

    const healthyRow = screen.getByText("1 Month").closest("tr")!;
    expect(within(healthyRow).getByText("In Stock")).toBeInTheDocument();
    expect(within(healthyRow).getByText("8 ready")).toBeInTheDocument();
    expect(healthyRow.textContent).toContain("1 reserved");

    const lowRow = screen.getByText("3 Months").closest("tr")!;
    expect(within(lowRow).getByText("Low Stock")).toBeInTheDocument();
    expect(within(lowRow).getByText("3 ready")).toBeInTheDocument();

    const outRow = screen.getByText("1 Year").closest("tr")!;
    expect(within(outRow).getByText("Out Of Stock")).toBeInTheDocument();
    // Sold out, not "No stock added" — this SKU has sold 5 units historically.
    expect(within(outRow).getByText("Sold out")).toBeInTheDocument();
  });

  it("Stock column shows 'No stock added' only for a SKU that has never held a stock row", async () => {
    const neverStocked = {
      id: 40,
      name: "Lifetime",
      isActive: true,
      deliveryType: "auto",
      product: { id: 4, name: "CapCut Pro", category: { id: 1, name: "Apps" } },
    };
    mockStock({
      ...STOCK_DATA,
      denominations: [...STOCK_DATA.denominations, neverStocked],
      counts: { ...STOCK_DATA.counts, "40": { available: 0, reserved: 0, sold: 0, dead: 0 } },
    });
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Lifetime")).toBeInTheDocument());

    const row = screen.getByText("Lifetime").closest("tr")!;
    expect(within(row).getByText("No stock added")).toBeInTheDocument();
    // Never having held stock is still "out of stock" from a Status-column
    // perspective — only the Stock column's wording distinguishes it from
    // "Sold out".
    expect(within(row).getByText("Out Of Stock")).toBeInTheDocument();
  });

  it("gives a manual-delivery SKU a Manual badge, excludes it from the Out of Stock tile, and never shows Download Credentials for it", async () => {
    const manualDenom = {
      id: 50,
      name: "Custom Rank Boost",
      isActive: true,
      deliveryType: "manual",
      product: { id: 5, name: "Mobile Legends", category: { id: 1, name: "Apps" } },
    };
    mockStock({
      ...STOCK_DATA,
      denominations: [...STOCK_DATA.denominations, manualDenom],
      // Manual SKUs never hold stock rows — no counts entry for id 50 at all.
    });
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Custom Rank Boost")).toBeInTheDocument());

    const kpiRow = screen.getByText("Total SKU").closest('[data-slot="card"]')!.parentElement as HTMLElement;
    // Total SKU includes the manual SKU; Out of Stock does not.
    expect(tileValue(kpiRow, "Total SKU")).toBe("4");
    expect(tileValue(kpiRow, "Out of Stock")).toBe("1");

    const row = screen.getByText("Custom Rank Boost").closest("tr")!;
    expect(within(row).getByText("Manual")).toBeInTheDocument();
    expect(within(row).queryByText("Out Of Stock")).not.toBeInTheDocument();
    expect(within(row).getByText("No stock added")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: "Actions for Custom Rank Boost" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("Download Credentials")).not.toBeInTheDocument();
  });

  it("gives an inactive SKU an Inactive badge and excludes it from every KPI tile", async () => {
    const inactiveDenom = {
      id: 60,
      name: "Discontinued Plan",
      isActive: false,
      deliveryType: "auto",
      product: { id: 6, name: "Old App", category: { id: 1, name: "Apps" } },
    };
    mockStock({
      ...STOCK_DATA,
      denominations: [...STOCK_DATA.denominations, inactiveDenom],
      counts: { ...STOCK_DATA.counts, "60": { available: 9, reserved: 0, sold: 0, dead: 0 } },
    });
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Discontinued Plan")).toBeInTheDocument());

    const kpiRow = screen.getByText("Total SKU").closest('[data-slot="card"]')!.parentElement as HTMLElement;
    // The inactive row's 9-available stock never inflates Total SKU or In stock (SKUs).
    expect(tileValue(kpiRow, "Total SKU")).toBe("3");
    expect(tileValue(kpiRow, "In stock (SKUs)")).toBe("2");

    const row = screen.getByText("Discontinued Plan").closest("tr")!;
    expect(within(row).getByText("Inactive")).toBeInTheDocument();
    expect(within(row).queryByText("In Stock")).not.toBeInTheDocument();
  });

  it("labels the column 'Restock requests' with an explanatory tooltip, and shows the count only while the SKU is out of stock", async () => {
    mockStock({ ...STOCK_DATA, waiting: { "10": 4, "30": 2 } });
    render(<StockPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());

    const header = screen.getByText("Restock requests");
    expect(header).toHaveAttribute("title", expect.stringContaining("asked to be notified"));
    expect(screen.queryByText("Waiting")).not.toBeInTheDocument();

    // Out-of-stock SKU with 2 requests -> the count.
    expect(within(screen.getByText("1 Year").closest("tr")!).getByText("2")).toBeInTheDocument();
    // In-stock SKU with 4 stale requests -> "—".
    expect(within(screen.getByText("1 Month").closest("tr")!).queryByText("4")).not.toBeInTheDocument();
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

  it("bounds a long denomination and product name so one row can't widen the table", async () => {
    const longName = "12 Months Premium Private Sharing Anti-Limit Full Garansi Resmi Selamanya";
    const longProduct = "Netflix Premium UHD 4K Multi-Device Family Plan With Extended Warranty";
    mockStock({
      ...STOCK_DATA,
      denominations: [
        {
          ...DENOM_HEALTHY,
          name: longName,
          product: { id: 1, name: longProduct, category: { id: 1, name: "Apps" } },
        },
      ],
    });
    render(<StockPage />, { wrapper: Wrapper });

    // The denomination cell stacks name over category; both must truncate
    // inside an explicitly bounded box, or the <td> just grows.
    const nameEl = await screen.findByTitle(longName);
    expect(nameEl).toHaveClass("truncate");
    expect(nameEl).toHaveTextContent(longName);
    expect(nameEl.parentElement?.className).toMatch(/max-w-\[240px\]/);

    const productEl = screen.getByTitle(longProduct);
    expect(productEl).toHaveClass("truncate");
    expect(productEl.className).toMatch(/max-w-\[240px\]/);
  });
});
