import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProductCreatePage } from "./ProductCreatePage";

const CATALOG_DATA = {
  categories: [{ id: 2, name: "Apps", isActive: true }],
  products: [],
};

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/catalog/new"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/catalog/new" element={children} />
          <Route path="/catalog/:productId" element={<div>product-detail-page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them. Mock all three to prevent unhandled errors when the
  // dropdown opens and focuses the first option.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  // apiPost reads CSRF from meta tag — provide empty string
  Object.defineProperty(document, "querySelector", {
    writable: true,
    value: (sel: string) =>
      sel === 'meta[name="csrf-token"]' ? { getAttribute: () => "" } : null,
  });
});

describe("ProductCreatePage", () => {
  it("renders name input and submit button after categories load", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(CATALOG_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/capcut pro/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /create product/i })).toBeInTheDocument();
  });

  it("submit button is disabled when name is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(CATALOG_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));
    expect(screen.getByRole("button", { name: /create product/i })).toBeDisabled();
  });

  it("navigates to product detail page on successful create", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    // First call: GET /api/catalog for categories
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(CATALOG_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      // Second call: POST /api/catalog/products
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42, name: "Netflix", slug: "netflix" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      // Third call: invalidateQueries triggers a re-fetch of ["catalog"]
      .mockResolvedValueOnce(
        new Response(JSON.stringify(CATALOG_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));

    // Select a category via the Radix combobox
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Apps" }));
    await user.click(screen.getByRole("option", { name: "Apps" }));

    // Fill in the name
    fireEvent.change(screen.getByPlaceholderText(/capcut pro/i), {
      target: { value: "Netflix" },
    });

    // Submit
    const btn = screen.getByRole("button", { name: /create product/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    // Should navigate to /catalog/42
    await waitFor(() =>
      expect(screen.getByText("product-detail-page")).toBeInTheDocument(),
    );
  });

  it("shows error message when create fails", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(CATALOG_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Category not found." }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Apps" }));
    await user.click(screen.getByRole("option", { name: "Apps" }));

    fireEvent.change(screen.getByPlaceholderText(/capcut pro/i), {
      target: { value: "Netflix" },
    });

    const btn = screen.getByRole("button", { name: /create product/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    await waitFor(() =>
      expect(screen.getByText(/400/i)).toBeInTheDocument(),
    );
  });
});
