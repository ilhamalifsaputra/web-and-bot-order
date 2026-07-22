import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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
  emoji: "📱",
  description: null,
  sortOrder: 0,
  isActive: true,
};

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

  it("shows categories (with product counts) and toggles one active when 'Manage categories' is clicked", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ categories: [CATEGORY], products: [PRODUCT] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /manage categories/i }));
    const categoriesPanel = screen
      .getByRole("switch", { name: "Apps active" })
      .closest('[data-slot="card"]') as HTMLElement;
    expect(within(categoriesPanel).getByText(/📱/)).toBeInTheDocument();
    expect(within(categoriesPanel).getByText("(1)")).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 2, isActive: false }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ categories: [{ ...CATEGORY, isActive: false }], products: [PRODUCT] }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Apps active" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/categories/2/active", expect.objectContaining({ method: "POST" })),
    );
  });

  it("edits a category via the edit dialog", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ categories: [CATEGORY], products: [PRODUCT] }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /manage categories/i }));

    fireEvent.click(screen.getByRole("button", { name: "Edit category" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Renamed" } });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 2, name: "Renamed" }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ categories: [{ ...CATEGORY, name: "Renamed" }], products: [PRODUCT] }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/categories/2", expect.objectContaining({ method: "PATCH" })),
    );
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
