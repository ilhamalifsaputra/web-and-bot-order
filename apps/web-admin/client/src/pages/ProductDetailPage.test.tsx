import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProductDetailPage } from "./ProductDetailPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/catalog/1"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/catalog/:productId" element={children} />
          <Route path="/catalog/:productId/denominations/new" element={<div>denomination-create-page</div>} />
          <Route path="/catalog/:productId/denominations/:denomId/edit" element={<div>denomination-edit-page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const PRODUCT_DETAIL = {
  product: {
    id: 1,
    name: "CapCut Pro",
    isActive: true,
    category: { id: 2, name: "Apps" },
    denominations: [
      {
        id: 10,
        name: "1 Month",
        price: "50000",
        costPrice: null,
        isActive: true,
        type: "PRIVATE",
        durationLabel: "Monthly", // intentionally different from name
      },
    ],
  },
  statsByDenom: {
    "10": { id: 10, available: 5, waiting: 0, rule: null },
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ProductDetailPage", () => {
  it("shows product detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(PRODUCT_DETAIL), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    // Wait for data to load — "Private" (StatusBadge title-cases "PRIVATE") is in the denomination type td (unique leaf cell)
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());
    // Denomination name appears once (durationLabel is "Monthly", not "1 Month")
    expect(screen.getByText("1 Month")).toBeInTheDocument();
  });

  it("shows the product photo upload field with no image set", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(PRODUCT_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Product photo")).toBeInTheDocument());
    expect(screen.getByText(/no image set/i)).toBeInTheDocument();
    expect(screen.getByText(/Recommended: 800x600px/)).toBeInTheDocument();
  });

  it("shows the product photo image when webImageUrl is set", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...PRODUCT_DETAIL, product: { ...PRODUCT_DETAIL.product, webImageUrl: "/uploads/products/product-abc.png" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("img", { name: "Product photo" })).toHaveAttribute("src", "/uploads/products/product-abc.png"));
  });

  it("navigates to the denomination create page on '+ Add Denomination' click", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(PRODUCT_DETAIL), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /add denomination/i }));

    await waitFor(() => expect(screen.getByText("denomination-create-page")).toBeInTheDocument());
  });

  it("badges a denomination whose flash sale is live right now", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...PRODUCT_DETAIL,
          statsByDenom: {
            "10": {
              id: 10,
              available: 5,
              waiting: 0,
              rule: null,
              flash: { discountPercent: "30", active: true },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());
    expect(screen.getByTitle("Flash sale live: 30% off")).toBeInTheDocument();
  });

  it("does not badge a denomination whose flash sale is scheduled but not yet live", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...PRODUCT_DETAIL,
          statsByDenom: {
            "10": {
              id: 10,
              available: 5,
              waiting: 0,
              rule: null,
              flash: { discountPercent: "30", active: false },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());
    expect(screen.queryByTitle(/flash sale live/i)).not.toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load product/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("navigates to the denomination edit page on 'Edit' click", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(PRODUCT_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => expect(screen.getByText("denomination-edit-page")).toBeInTheDocument());
  });

  it("deletes a denomination after confirming", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(PRODUCT_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...PRODUCT_DETAIL, product: { ...PRODUCT_DETAIL.product, denominations: [] } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/denominations/10", expect.objectContaining({ method: "DELETE" })),
    );
    await waitFor(() => expect(screen.queryByText("Private")).not.toBeInTheDocument());
  });
});
