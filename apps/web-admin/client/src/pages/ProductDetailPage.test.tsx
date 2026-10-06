import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
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
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("ProductDetailPage", () => {
  it("marks a denomination below cost so the admin can review its price", async () => {
    const data = { ...PRODUCT_DETAIL, statsByDenom: { "10": { ...PRODUCT_DETAIL.statsByDenom["10"], belowCost: true } } };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<ProductDetailPage />, { wrapper: Wrapper });
    expect(await screen.findByText("Below Cost")).toBeInTheDocument();
  });

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

  it("shows '—' (not a fake 0) in the Stock column for a denomination the server sent no stat for", async () => {
    const missingStat = {
      ...PRODUCT_DETAIL,
      product: {
        ...PRODUCT_DETAIL.product,
        denominations: [
          ...PRODUCT_DETAIL.product.denominations,
          {
            id: 20,
            name: "3 Months",
            price: "120000",
            costPrice: null,
            isActive: true,
            type: "PRIVATE",
            durationLabel: "Quarterly",
          },
        ],
      },
      // No "20" entry — statsByDenom is missing data for this denomination.
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(missingStat), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("3 Months")).toBeInTheDocument());

    // Column order: select, name, type, duration, price, stock, … — index 5
    // is the Stock cell.
    const row = screen.getByText("3 Months").closest("tr")!;
    expect(row.querySelectorAll("td")[5]).toHaveTextContent("—");

    // The denomination WITH a real stat still shows its true (possibly zero) count.
    const otherRow = screen.getByText("1 Month").closest("tr")!;
    expect(otherRow.querySelectorAll("td")[5]).toHaveTextContent("5");
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

    await user.click(screen.getByRole("button", { name: "Actions for 1 Month" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Edit"));

    await waitFor(() => expect(screen.getByText("denomination-edit-page")).toBeInTheDocument());
  });

  it("deletes a denomination after confirming", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // URL-routed (not a fixed mockResolvedValueOnce chain): ProductDetailPage
    // fires useCatalog's `/api/catalog` mount fetch alongside
    // useProductDetail's `/api/catalog/1`, so a fixed FIFO queue of Once-
    // responses no longer lines up with the real calls (mount fetch +
    // product-detail load + DELETE + post-delete refetch).
    let denomsDeleted = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/catalog/denominations/10" && init?.method === "DELETE") {
        denomsDeleted = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body =
        url === "/api/catalog"
          ? { categories: [], products: [] }
          : denomsDeleted
            ? { ...PRODUCT_DETAIL, product: { ...PRODUCT_DETAIL.product, denominations: [] } }
            : PRODUCT_DETAIL;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for 1 Month" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Delete"));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/denominations/10", expect.objectContaining({ method: "DELETE" })),
    );
    await waitFor(() => expect(screen.queryByText("Private")).not.toBeInTheDocument());
  });

  it("moves the product to another category from the edit card", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body =
        url === "/api/catalog"
          ? {
              categories: [
                { id: 2, name: "Apps", slug: "apps", emoji: null, description: null, sortOrder: 0, isActive: true },
                { id: 5, name: "Games", slug: "games", emoji: null, description: null, sortOrder: 1, isActive: true },
              ],
              products: [],
            }
          : url.startsWith("/api/catalog/1") && !init?.method
            ? PRODUCT_DETAIL
            : { ok: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /edit product/i }));
    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.click(await screen.findByRole("option", { name: "Games" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/catalog/products/1",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const patch = fetchSpy.mock.calls.find(
      ([url, init]) => url === "/api/catalog/products/1" && (init as RequestInit)?.method === "PATCH",
    )!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toMatchObject({ categoryId: 5 });
  });

  // Task 14: gameVariant/gameVariantEmoji/gameRegion are always sent from
  // the edit form's PATCH body (blank means clear to null server-side), same
  // as description/whatYouGet above.
  it("submits gameVariant, gameVariantEmoji and gameRegion in the PATCH body", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const withGameFields = {
      ...PRODUCT_DETAIL,
      product: { ...PRODUCT_DETAIL.product, gameVariant: "Diamonds", gameVariantEmoji: "💎", gameRegion: "Global" },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = url.startsWith("/api/catalog/1") && !init?.method ? withGameFields : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /edit product/i }));
    expect(screen.getByPlaceholderText(/e\.g\. diamonds/i)).toHaveValue("Diamonds");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/products/1", expect.objectContaining({ method: "PATCH" })),
    );
    const patch = fetchSpy.mock.calls.find(
      ([url, init]) => url === "/api/catalog/products/1" && (init as RequestInit)?.method === "PATCH",
    )!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toMatchObject({
      gameVariant: "Diamonds",
      gameVariantEmoji: "💎",
      gameRegion: "Global",
    });
  });

  it("select-all checks every denomination, and the bulk bar activates/deactivates them", async () => {
    const user = userEvent.setup();
    const TWO_DENOMS = {
      ...PRODUCT_DETAIL,
      product: {
        ...PRODUCT_DETAIL.product,
        denominations: [
          { id: 10, name: "1 Month", price: "50000", costPrice: null, isActive: true, type: "PRIVATE", durationLabel: "Monthly" },
          { id: 11, name: "3 Months", price: "120000", costPrice: null, isActive: false, type: "PRIVATE", durationLabel: "Quarterly" },
        ],
      },
      statsByDenom: {
        "10": { id: 10, available: 5, waiting: 0, rule: null },
        "11": { id: 11, available: 5, waiting: 0, rule: null },
      },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(TWO_DENOMS), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());
    expect(screen.getByText("3 Months")).toBeInTheDocument();

    // No bulk bar until something is selected.
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select all denominations" }));

    expect(screen.getByRole("checkbox", { name: "Select 1 Month" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select 3 Months" })).toBeChecked();
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, count: 2 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(TWO_DENOMS), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/catalog/denominations/bulk-active",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = fetchSpy.mock.calls.find(
      ([url, init]) => url === "/api/catalog/denominations/bulk-active" && (init as RequestInit)?.method === "POST",
    )!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ ids: [10, 11], active: true });

    // Selection clears and the bulk bar disappears after a successful bulk action.
    await waitFor(() => expect(screen.queryByText(/selected/)).not.toBeInTheDocument());
  });

  it("toggling select-all off clears the selection", async () => {
    const user = userEvent.setup();
    const TWO_DENOMS = {
      ...PRODUCT_DETAIL,
      product: {
        ...PRODUCT_DETAIL.product,
        denominations: [
          { id: 10, name: "1 Month", price: "50000", costPrice: null, isActive: true, type: "PRIVATE", durationLabel: "Monthly" },
          { id: 11, name: "3 Months", price: "120000", costPrice: null, isActive: false, type: "PRIVATE", durationLabel: "Quarterly" },
        ],
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(TWO_DENOMS), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("1 Month")).toBeInTheDocument());

    const selectAll = screen.getByRole("checkbox", { name: "Select all denominations" });
    await user.click(selectAll);
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await user.click(selectAll);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select 1 Month" })).not.toBeChecked();
  });

  // Fase 12 task 22: thumbnailKind (default placeholder art style) and
  // currencyIconKind (denomination-card currency chip) — optional selects
  // shown in the edit-mode form, hidden entirely (not disabled) for a
  // product whose category is in the PREMIUM_APPS group.
  it("shows the thumbnail style and currency icon selects for a non-PREMIUM_APPS product", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body =
        url === "/api/catalog"
          ? { categories: [], products: [] }
          : url.startsWith("/api/catalog/1") && !init?.method
            ? PRODUCT_DETAIL
            : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /edit product/i }));

    expect(screen.getByRole("combobox", { name: /gaya thumbnail default/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /ikon currency/i })).toBeInTheDocument();
  });

  it("hides the thumbnail style and currency icon selects for a PREMIUM_APPS product", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const premiumAppsProduct = {
      ...PRODUCT_DETAIL,
      product: { ...PRODUCT_DETAIL.product, category: { id: 2, name: "Apps", group: "PREMIUM_APPS" } },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body =
        url === "/api/catalog"
          ? { categories: [], products: [] }
          : url.startsWith("/api/catalog/1") && !init?.method
            ? premiumAppsProduct
            : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /edit product/i }));

    expect(screen.queryByRole("combobox", { name: /gaya thumbnail default/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /ikon currency/i })).not.toBeInTheDocument();
  });

  it("submits the chosen thumbnailKind/currencyIconKind in the PATCH body, and 'Automatic' as null", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body =
        url === "/api/catalog"
          ? { categories: [], products: [] }
          : url.startsWith("/api/catalog/1") && !init?.method
            ? PRODUCT_DETAIL
            : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /edit product/i }));
    await user.click(screen.getByRole("combobox", { name: /gaya thumbnail default/i }));
    await user.click(await screen.findByRole("option", { name: "Steam" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/products/1", expect.objectContaining({ method: "PATCH" })),
    );
    const patch = fetchSpy.mock.calls.find(
      ([url, init]) => url === "/api/catalog/products/1" && (init as RequestInit)?.method === "PATCH",
    )!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toMatchObject({
      thumbnailKind: "steam",
      currencyIconKind: null,
    });
  });

  it("links the category to that category's products", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(PRODUCT_DETAIL), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Apps" })).toBeInTheDocument();
  });
});

describe("ProductDetailPage Telegram button hints", () => {
  it("hints Name, Game Variant and Game Region in the edit form, and an over-budget name still saves", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const detail = { ...PRODUCT_DETAIL, product: { ...PRODUCT_DETAIL.product, gameVariant: "Diamonds", gameVariantEmoji: "💎", gameRegion: "Global" } };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = url.startsWith("/api/catalog/1") && !init?.method ? detail : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Private")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /edit product/i }));

    // CapCut Pro = 10 cells of 30; Diamonds = 8 of 15 (a variant emoji is set); Global = 6 of 18.
    expect(screen.getAllByTestId("button-label-counter").map((el) => el.textContent)).toEqual(["10/30", "8/15", "6/18"]);
    expect(screen.getAllByText(/Shown on the Telegram/)).toHaveLength(3);

    const longName = "CapCut Pro Supplier Name That Is Far Too Long For One Button";
    const nameInput = screen.getByDisplayValue("CapCut Pro");
    fireEvent.change(nameInput, { target: { value: longName } });
    expect(screen.getAllByTestId("button-label-counter")[0]).toHaveAttribute("data-state", "over");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/products/1", expect.objectContaining({ method: "PATCH" })),
    );
    const patch = fetchSpy.mock.calls.find(([url, init]) => url === "/api/catalog/products/1" && (init as RequestInit)?.method === "PATCH")!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toMatchObject({ name: longName });
  });
});
