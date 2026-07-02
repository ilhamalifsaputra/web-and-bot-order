import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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
  category: { id: 2, name: "Apps" },
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

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("CatalogPage", () => {
  it("shows product rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [], products: [PRODUCT] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());
    expect(screen.getByText("Apps")).toBeInTheDocument();
  });

  it("shows empty state when no products", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [], products: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no products yet/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load catalog/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows Import CSV button", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [], products: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText(/import csv/i)).toBeInTheDocument(),
    );
  });

  it("opens import panel on button click", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [], products: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByText(/import csv/i));
    fireEvent.click(screen.getByText(/import csv/i));
    expect(
      screen.getByPlaceholderText(/seed category/i),
    ).toBeInTheDocument();
  });

  it("shows preview table after preview API call", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [], products: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByText(/import csv/i));
    fireEvent.click(screen.getByText(/import csv/i));
    fireEvent.change(screen.getByPlaceholderText(/seed category/i), {
      target: { value: "Test|P1|1GB|PRIVATE|30|50000" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
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
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() =>
      expect(screen.getByText("1 valid")).toBeInTheDocument(),
    );
  });

  it("shows categories and toggles one active when 'Manage categories' is clicked", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [CATEGORY], products: [PRODUCT] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /manage categories/i }));
    expect(screen.getByText(/📱 Apps/)).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 2, isActive: false }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [{ ...CATEGORY, isActive: false }], products: [PRODUCT] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Apps active" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/categories/2/active", expect.objectContaining({ method: "POST" })),
    );
  });

  it("edits a category via the edit dialog", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [CATEGORY], products: [PRODUCT] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /manage categories/i }));

    fireEvent.click(screen.getByRole("button", { name: "Edit category" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Renamed" } });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 2, name: "Renamed" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [{ ...CATEGORY, name: "Renamed" }], products: [PRODUCT] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/categories/2", expect.objectContaining({ method: "PATCH" })),
    );
  });

  it("deletes a product after confirming", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [], products: [PRODUCT] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [], products: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/products/1", expect.objectContaining({ method: "DELETE" })),
    );
    await waitFor(() => expect(screen.queryByText("CapCut Pro")).not.toBeInTheDocument());
  });

  it("selects products and bulk-deactivates them", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [], products: [PRODUCT] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<CatalogPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /select capcut pro/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ categories: [], products: [{ ...PRODUCT, isActive: false }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/catalog/products/bulk-active",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: [1], active: false }) }),
      ),
    );
  });
});
