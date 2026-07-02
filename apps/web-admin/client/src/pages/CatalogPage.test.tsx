import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
});
