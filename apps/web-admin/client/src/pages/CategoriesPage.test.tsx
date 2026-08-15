import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CategoriesPage } from "./CategoriesPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const APPS = {
  id: 2,
  name: "Apps",
  slug: "apps",
  emoji: "📱",
  description: "Mobile apps",
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
  isActive: false,
};

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

const ARCHIVED_PRODUCT = { ...PRODUCT, id: 9, name: "Old App", isArchived: true };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mock fetch: the catalog GET returns `catalog`; every other call succeeds. */
function mockFetch(catalog: unknown, overrides: Record<string, Response> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/catalog" && !init?.method) return jsonResponse(catalog);
    const key = `${init?.method ?? "GET"} ${url}`;
    return overrides[key] ?? jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calls(fetchMock: ReturnType<typeof vi.fn>, method: string) {
  return fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === method,
  ) as [string, RequestInit][];
}

beforeEach(() => {
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("CategoriesPage", () => {
  it("lists categories with their slug and non-archived product counts", async () => {
    mockFetch({ categories: [APPS, GAMES], products: [PRODUCT, ARCHIVED_PRODUCT] });
    render(<CategoriesPage />, { wrapper: Wrapper });

    expect(await screen.findByText(/Apps/)).toBeInTheDocument();
    expect(screen.getByText("/c/apps")).toBeInTheDocument();
    expect(screen.getByText("/c/games")).toBeInTheDocument();
    // One product in Apps, and the archived one is not counted.
    expect(screen.getByRole("button", { name: "1 product" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "0 products" })).toBeInTheDocument();
  });

  it("opens the create dialog from the header button", async () => {
    mockFetch({ categories: [APPS], products: [] });
    render(<CategoriesPage />, { wrapper: Wrapper });

    fireEvent.click(await screen.findByRole("button", { name: /new category/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("New category")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toBeInTheDocument();
  });

  it("reorders by posting the full id list, and disables the arrows at the ends", async () => {
    const fetchMock = mockFetch({ categories: [APPS, GAMES], products: [] });
    render(<CategoriesPage />, { wrapper: Wrapper });

    expect(await screen.findByLabelText("Move Apps up")).toBeDisabled();
    expect(screen.getByLabelText("Move Games down")).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Move Apps down"));

    await waitFor(() => expect(calls(fetchMock, "POST").length).toBe(1));
    const [url, init] = calls(fetchMock, "POST")[0]!;
    expect(url).toBe("/api/catalog/categories/reorder");
    expect(JSON.parse(String(init.body))).toEqual({ ids: [5, 2] });
  });

  it("deletes an empty category through the confirmation dialog", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch({ categories: [GAMES], products: [] });
    render(<CategoriesPage />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: "Actions for Games" }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(calls(fetchMock, "DELETE").length).toBe(1));
    expect(calls(fetchMock, "DELETE")[0]![0]).toBe("/api/catalog/categories/5");
  });

  it("shows the server's reason when a category still holds products, and offers its products", async () => {
    const fetchMock = mockFetch(
      { categories: [APPS], products: [PRODUCT] },
      {
        "DELETE /api/catalog/categories/2": jsonResponse(
          { error: "Cannot delete: move or delete its 1 product(s) first.", productCount: 1 },
          409,
        ),
      },
    );
    const user = userEvent.setup();
    render(<CategoriesPage />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: "Actions for Apps" }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText("Cannot delete: move or delete its 1 product(s) first."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view its products/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("offers a way in from the empty state", async () => {
    mockFetch({ categories: [], products: [] });
    render(<CategoriesPage />, { wrapper: Wrapper });

    expect(await screen.findByText("No categories yet")).toBeInTheDocument();
    // Header button plus the empty-state action.
    expect(screen.getAllByRole("button", { name: /new category/i }).length).toBeGreaterThan(1);
  });

  it("toggles a category active through the existing endpoint", async () => {
    const fetchMock = mockFetch({ categories: [GAMES], products: [] });
    render(<CategoriesPage />, { wrapper: Wrapper });

    fireEvent.click(await screen.findByLabelText("Games active"));

    await waitFor(() => expect(calls(fetchMock, "POST").length).toBe(1));
    const [url, init] = calls(fetchMock, "POST")[0]!;
    expect(url).toBe("/api/catalog/categories/5/active");
    expect(JSON.parse(String(init.body))).toEqual({ active: true });
  });
});
