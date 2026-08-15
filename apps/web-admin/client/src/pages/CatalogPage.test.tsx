import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CatalogPage } from "./CatalogPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const PRODUCT = {
  id: 1,
  name: "CapCut Pro",
  isActive: true,
  isArchived: false,
  webImageUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  category: { id: 2, name: "Apps", emoji: "📱" },
  _count: { denominations: 3 },
};

const CATEGORY = {
  id: 2,
  name: "Apps",
  slug: "apps",
  emoji: "📱",
  description: null,
  sortOrder: 0,
  isActive: true,
};

const GAMES = {
  id: 5,
  name: "Games",
  slug: "games",
  emoji: "🎮",
  description: null,
  sortOrder: 1,
  isActive: true,
};

const GAMES_PRODUCT = {
  ...PRODUCT,
  id: 4,
  name: "Free Fire",
  category: { id: 5, name: "Games", emoji: "🎮" },
};

/** Renders the page at a given URL and exposes where navigation lands. */
let location = "";
function LocationProbe() {
  location = `${useLocation().pathname}`;
  return null;
}

function renderAt(entry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <CatalogPage />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function currentPath() {
  return location;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Click the header's "Import CSV" ghost button specifically — once a product
 *  list is empty, the empty state also renders its own "Import CSV" button,
 *  so plain getByText/getByRole would match two elements. */
function headerImportCsvButton() {
  return screen.getAllByRole("button", { name: /import csv/i })[0];
}

beforeEach(() => {
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("CatalogPage", () => {
  it("shows product rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [PRODUCT] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());
    expect(screen.getByText("Apps")).toBeInTheDocument();
  });

  it("truncates a long product name and category name with a bounded width, keeping the full text in title (Task 4)", async () => {
    const longName =
      "Netflix Premium 4K UHD 12-Month Family Plan Shared Warranty Subscription";
    const longCategory = "Streaming & Entertainment Subscriptions Bundle";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        categories: [],
        products: [
          {
            ...PRODUCT,
            name: longName,
            category: { id: 3, name: longCategory, emoji: "🎬" },
          },
        ],
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });

    const nameEl = await screen.findByTitle(longName);
    expect(nameEl).toHaveClass("truncate");
    expect(nameEl.closest(".min-w-0")).not.toBeNull();
    expect(nameEl.closest(".min-w-0")?.className).toMatch(/max-w-\[240px\]/);

    const categoryEl = screen.getByTitle(longCategory);
    expect(categoryEl).toHaveClass("truncate");
  });

  it("shows empty state when no products, with two distinct CTAs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no products yet/i)).toBeInTheDocument());

    const emptyState = screen.getByText(/no products yet/i).parentElement!;
    expect(within(emptyState).getByRole("button", { name: /add product/i })).toBeInTheDocument();
    expect(within(emptyState).getByRole("button", { name: /import csv/i })).toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load catalog/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows Import CSV button", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(headerImportCsvButton()).toBeInTheDocument());
  });

  it("opens import panel on button click", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => headerImportCsvButton());
    fireEvent.click(headerImportCsvButton());
    expect(
      screen.getByPlaceholderText(/seed category/i),
    ).toBeInTheDocument();
  });

  it("shows preview table after preview API call", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => headerImportCsvButton());
    fireEvent.click(headerImportCsvButton());
    fireEvent.change(screen.getByPlaceholderText(/seed category/i), {
      target: { value: "Test|P1|1GB|PRIVATE|30|50000" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        rows: [
          {
            line: 1,
            ok: true,
            category: "Test",
            product: "P1",
            denomination: "1GB",
            price: "50000",
          },
        ],
        validCount: 1,
        invalidCount: 0,
        csv: "test",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() =>
      expect(screen.getByText("1 valid")).toBeInTheDocument(),
    );
  });

  it("truncates a long CSV preview error with a bounded width, keeping the full text in title (Task 4)", async () => {
    const longError =
      "Row rejected: denomination price must be a positive integer expressed in the smallest currency unit, but received a non-numeric value instead";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => headerImportCsvButton());
    fireEvent.click(headerImportCsvButton());
    fireEvent.change(screen.getByPlaceholderText(/seed category/i), {
      target: { value: "Test|P1|1GB|PRIVATE|30|notanumber" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        rows: [
          {
            line: 1,
            ok: false,
            category: "Test",
            product: "P1",
            denomination: "1GB",
            price: "notanumber",
            error: longError,
          },
        ],
        validCount: 0,
        invalidCount: 1,
        csv: "test",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));

    const errorEl = await screen.findByTitle(longError);
    expect(errorEl).toHaveClass("truncate", "text-rust");
    expect(errorEl.className).toMatch(/max-w-\[320px\]/);
  });

  it("sends 'Manage categories' and the Categories tile to the categories page", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(jsonResponse({ categories: [CATEGORY], products: [PRODUCT] }));
    renderAt("/catalog");
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /manage categories/i }));
    expect(currentPath()).toBe("/categories");

    fireEvent.click(screen.getByRole("button", { name: /Categories 1/ }));
    expect(currentPath()).toBe("/categories");
  });

  it("moves the selected products to a category in bulk", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(jsonResponse({ categories: [CATEGORY, GAMES], products: [PRODUCT] }));
    renderAt("/catalog");
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select CapCut Pro/i }));
    await user.click(screen.getByRole("combobox", { name: "Move to category" }));
    await user.click(await screen.findByRole("option", { name: /Games/ }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/catalog/products/bulk-category",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = fetchSpy.mock.calls.find(([url]) => url === "/api/catalog/products/bulk-category")!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ ids: [1], categoryId: 5 });
  });

  it("starts filtered when the URL names a category", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(
      jsonResponse({ categories: [CATEGORY, GAMES], products: [PRODUCT, GAMES_PRODUCT] }),
    );
    renderAt("/catalog?categoryId=5");

    expect(await screen.findByText("Free Fire")).toBeInTheDocument();
    expect(screen.queryByText("CapCut Pro")).not.toBeInTheDocument();
  });

  it("deletes a product via the row's actions menu, after confirming", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [PRODUCT] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /actions for capcut pro/i }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
    const dialog = await screen.findByRole("dialog");

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ categories: [], products: [] }));
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/products/1", expect.objectContaining({ method: "DELETE" })),
    );
    await waitFor(() => expect(screen.queryByText("CapCut Pro")).not.toBeInTheDocument());
  });

  it("archives a product from the row's actions menu; it drops out of the default view", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [PRODUCT] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /actions for capcut pro/i }));

    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 1, isArchived: true }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [{ ...PRODUCT, isArchived: true }] }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /^archive$/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/catalog/products/1/archive",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ archived: true }) }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("CapCut Pro")).not.toBeInTheDocument());
  });

  it("selects products and bulk-deactivates them", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [PRODUCT] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /select capcut pro/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ok: true, count: 1 }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [{ ...PRODUCT, isActive: false }] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/catalog/products/bulk-active",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: [1], active: false }) }),
      ),
    );
  });

  it("select-all selects every product currently passing the filters", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        categories: [CATEGORY],
        products: [PRODUCT, { ...PRODUCT, id: 2, name: "VPN Yearly" }],
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /select all products/i }));

    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("select-all deselects everything when every filtered product is already selected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        categories: [CATEGORY],
        products: [PRODUCT, { ...PRODUCT, id: 2, name: "VPN Yearly" }],
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    const selectAll = screen.getByRole("checkbox", { name: /select all products/i });
    fireEvent.click(selectAll);
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(selectAll);

    expect(screen.queryByText(/\d+ selected/)).not.toBeInTheDocument();
  });

  // Catalog filters client-side, so a selection surviving a filter change would
  // leave the bulk Activate/Deactivate/Archive buttons acting on products the
  // admin can no longer see.
  it("clears the selection when a filter narrows the visible products", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        categories: [CATEGORY],
        products: [PRODUCT, { ...PRODUCT, id: 2, name: "VPN Yearly" }],
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /select capcut pro/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/filter by product or category/i), {
      target: { value: "vpn" },
    });

    await waitFor(() => expect(screen.queryByText("CapCut Pro")).not.toBeInTheDocument());
    expect(screen.queryByText(/\d+ selected/)).not.toBeInTheDocument();
  });

  it("renders a thumbnail image when webImageUrl is set", async () => {
    // Thumbnail <img> is decorative (alt=""), so its accessible role is
    // "presentation", not "img" — query the DOM directly instead of by role.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ categories: [], products: [{ ...PRODUCT, webImageUrl: "https://example.test/p.png" }] }),
    );
    const { container } = render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe("https://example.test/p.png");
  });

  it("falls back to the category emoji, then a generic icon, when no thumbnail is set", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        categories: [],
        products: [
          { ...PRODUCT, id: 1, webImageUrl: null, category: { id: 2, name: "Apps", emoji: "📱" } },
          { ...PRODUCT, id: 2, name: "No Emoji Co", webImageUrl: null, category: null },
        ],
      }),
    );
    const { container } = render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());
    expect(screen.getByText("No Emoji Co")).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg.lucide-package")).toBeTruthy();
  });

  it("filters the table by category, status and search together", async () => {
    const user = userEvent.setup();
    const other = {
      ...PRODUCT,
      id: 2,
      name: "VPN Yearly",
      isActive: false,
      category: { id: 3, name: "VPN", emoji: "🔒" },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        categories: [CATEGORY, { ...CATEGORY, id: 3, name: "VPN", emoji: "🔒" }],
        products: [PRODUCT, other],
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());
    expect(screen.getByText("VPN Yearly")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/filter by product or category/i), {
      target: { value: "vpn" },
    });
    await waitFor(() => expect(screen.queryByText("CapCut Pro")).not.toBeInTheDocument());
    expect(screen.getByText("VPN Yearly")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/filter by product or category/i), {
      target: { value: "" },
    });

    const statusSelect = screen.getByText("All statuses").closest('[role="combobox"]')!;
    await user.click(statusSelect);
    await user.click(await screen.findByRole("option", { name: "Inactive" }));
    await waitFor(() => expect(screen.queryByText("CapCut Pro")).not.toBeInTheDocument());
    expect(screen.getByText("VPN Yearly")).toBeInTheDocument();
  });

  it('the "Archived" status filter is the only way to see an archived product', async () => {
    const user = userEvent.setup();
    const archived = { ...PRODUCT, id: 2, name: "Retired App", isArchived: true };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ categories: [CATEGORY], products: [PRODUCT, archived] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());
    expect(screen.queryByText("Retired App")).not.toBeInTheDocument();

    const statusSelect = screen.getByText("All statuses").closest('[role="combobox"]')!;
    await user.click(statusSelect);
    await user.click(await screen.findByRole("option", { name: "Archived" }));

    await waitFor(() => expect(screen.getByText("Retired App")).toBeInTheDocument());
    expect(screen.queryByText("CapCut Pro")).not.toBeInTheDocument();
  });
});
