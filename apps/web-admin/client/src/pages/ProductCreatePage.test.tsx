import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProductCreatePage } from "./ProductCreatePage";
import { apiPost, apiGet } from "../api/client";

vi.mock("../api/client", () => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(),
}));

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
  vi.resetAllMocks();
  vi.restoreAllMocks();
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them. Mock all three to prevent unhandled errors when the
  // dropdown opens and focuses the first option.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  // The page reads categories through the shared useCatalog hook, which calls
  // apiGet. Route that back to the global fetch each test already stubs.
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    const res = await fetch(path);
    return res.json();
  });
});

describe("ProductCreatePage", () => {
  it("shows game settings only for a game category and omits their draft after switching to Premium Apps", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiGet).mockResolvedValue({
      categories: [
        { id: 2, name: "Apps", isActive: true, group: "PREMIUM_APPS" },
        { id: 3, name: "Games", isActive: true, group: "GAME_TOPUP" },
      ],
      products: [],
    });
    vi.mocked(apiPost).mockResolvedValue({ id: 42 });
    render(<ProductCreatePage />, { wrapper: Wrapper });
    expect(screen.queryByText("Game Variant")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Games" }));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. diamonds/i), { target: { value: "Diamonds" } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. global/i), { target: { value: "Global" } });
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Apps" }));
    expect(screen.queryByText("Game Variant")).not.toBeInTheDocument();
    expect(screen.queryByText("Game Variant Emoji")).not.toBeInTheDocument();
    expect(screen.queryByText("Game Region")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/capcut pro/i), { target: { value: "CapCut Pro" } });
    await user.click(screen.getByRole("button", { name: /create product/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const body = vi.mocked(apiPost).mock.calls[0][1];
    expect(body).not.toHaveProperty("gameVariant");
    expect(body).not.toHaveProperty("gameVariantEmoji");
    expect(body).not.toHaveProperty("gameRegion");
  });

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

    vi.mocked(apiPost).mockResolvedValueOnce({ id: 42, name: "Netflix", slug: "netflix" });

    // First call: GET /api/catalog for categories
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(CATALOG_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      // Second call: invalidateQueries triggers a re-fetch of ["catalog"]
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

  // Task 14: gameVariant/gameVariantEmoji/gameRegion — omitted from the
  // submit body when blank (same conditional-spread pattern as emoji), sent
  // trimmed when filled in.
  it("includes gameVariant, gameVariantEmoji and gameRegion in the submit body only when filled in", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    vi.mocked(apiPost).mockResolvedValueOnce({ id: 42, name: "Netflix", slug: "netflix" });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...CATALOG_DATA, categories: [{ id: 2, name: "Apps", isActive: true, group: "GAME_TOPUP" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...CATALOG_DATA, categories: [{ id: 2, name: "Apps", isActive: true, group: "GAME_TOPUP" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Apps" }));
    await user.click(screen.getByRole("option", { name: "Apps" }));

    fireEvent.change(screen.getByPlaceholderText(/capcut pro/i), { target: { value: "Netflix" } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. diamonds/i), { target: { value: " Diamonds " } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 💎/i), { target: { value: " 💎 " } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. global/i), { target: { value: " Global " } });

    const btn = screen.getByRole("button", { name: /create product/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/catalog/products", expect.objectContaining({
      gameVariant: "Diamonds",
      gameVariantEmoji: "💎",
      gameRegion: "Global",
    })));
  });

  it("omits gameVariant, gameVariantEmoji and gameRegion from the submit body when left blank", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    vi.mocked(apiPost).mockResolvedValueOnce({ id: 42, name: "Netflix", slug: "netflix" });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(CATALOG_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(CATALOG_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Apps" }));
    await user.click(screen.getByRole("option", { name: "Apps" }));

    fireEvent.change(screen.getByPlaceholderText(/capcut pro/i), { target: { value: "Netflix" } });

    const btn = screen.getByRole("button", { name: /create product/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const body = vi.mocked(apiPost).mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("gameVariant");
    expect(body).not.toHaveProperty("gameVariantEmoji");
    expect(body).not.toHaveProperty("gameRegion");
  });

  it("creates a new category inline via the + New category affordance", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    vi.mocked(apiPost).mockResolvedValueOnce({ category: { id: 9, name: "Streaming" } });

    // First call: GET /api/catalog for categories
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(CATALOG_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      // Second call: invalidateQueries triggers a re-fetch of ["catalog"]
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            categories: [...CATALOG_DATA.categories, { id: 9, name: "Streaming", isActive: true }],
            products: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));

    // Open the category combobox and pick "+ New category"
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "+ New category" }));
    await user.click(screen.getByRole("option", { name: "+ New category" }));

    // The Select swaps for an Input + Confirm/Cancel
    const input = await screen.findByPlaceholderText(/new category name/i);
    fireEvent.change(input, { target: { value: "Streaming" } });

    const confirmBtn = screen.getByRole("button", { name: /confirm/i });
    await waitFor(() => expect(confirmBtn).not.toBeDisabled());
    await user.click(confirmBtn);

    expect(apiPost).toHaveBeenCalledWith("/api/catalog/categories", { name: "Streaming" });

    // Collapses back to the Select, with the new category selected
    await waitFor(() => expect(screen.queryByPlaceholderText(/new category name/i)).not.toBeInTheDocument());
    expect(screen.getByRole("combobox")).toHaveTextContent("Streaming");
  });

  it("cancelling inline category creation returns to the Select without submitting", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(CATALOG_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "+ New category" }));
    await user.click(screen.getByRole("option", { name: "+ New category" }));

    const input = await screen.findByPlaceholderText(/new category name/i);
    fireEvent.change(input, { target: { value: "Streaming" } });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.queryByPlaceholderText(/new category name/i)).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("shows error message when create fails", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    vi.mocked(apiPost).mockRejectedValueOnce(new Error("Category not found."));

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(CATALOG_DATA), {
        status: 200,
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
      expect(screen.getByText(/category not found/i)).toBeInTheDocument(),
    );
  });

  it("sets switched-off categories apart so a new product isn't filed into a dead shelf", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          categories: [
            { id: 2, name: "Apps", isActive: true },
            { id: 7, name: "Retired", isActive: false },
          ],
          products: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));
    await user.click(screen.getByRole("combobox"));

    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText(/inactive — hidden from the shop/i)).toBeInTheDocument();

    // The inactive one is still selectable, just not mixed in with the rest.
    const group = within(listbox).getByRole("group");
    expect(within(group).getByRole("option", { name: "Retired" })).toBeInTheDocument();
    expect(within(group).queryByRole("option", { name: "Apps" })).not.toBeInTheDocument();
  });
});

describe("ProductCreatePage Telegram button hints", () => {
  const jsonOk = () =>
    new Response(JSON.stringify(CATALOG_DATA), { status: 200, headers: { "Content-Type": "application/json" } });

  it("explains the Telegram button limit and counts cells under Name, Game Variant and Game Region", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiGet).mockResolvedValue({ ...CATALOG_DATA, categories: [{ id: 2, name: "Games", isActive: true, group: "GAME_TOPUP" }] });
    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Games" }));

    expect(screen.getAllByText(/Shown on the Telegram/)).toHaveLength(3);
    expect(screen.getAllByTestId("button-label-counter").map((el) => el.textContent)).toEqual(["0/30", "0/18", "0/18"]);

    fireEvent.change(screen.getByPlaceholderText(/capcut pro/i), { target: { value: "Ab💎你" } });
    expect(screen.getAllByTestId("button-label-counter")[0]).toHaveTextContent("6/30");
    // An emoji in the variant emoji field leaves less room for the variant name.
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 💎/i), { target: { value: "💎" } });
    expect(screen.getAllByTestId("button-label-counter")[1]).toHaveTextContent("0/15");
  });

  it("only warns when the name is over the budget: it is never truncated, capped, or blocked from saving", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ id: 42, name: "x", slug: "x" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonOk());
    render(<ProductCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByPlaceholderText(/capcut pro/i));
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Apps" }));
    await user.click(screen.getByRole("option", { name: "Apps" }));

    const longName = "Supplier Product Name That Is Far Too Long For A Button";
    const input = screen.getByPlaceholderText(/capcut pro/i);
    fireEvent.change(input, { target: { value: longName } });
    expect(input).toHaveValue(longName);
    expect(input).not.toHaveAttribute("maxlength");
    expect(screen.getAllByTestId("button-label-counter")[0]).toHaveAttribute("data-state", "over");
    expect(screen.getByTestId("button-label-warning")).toBeInTheDocument();

    const btn = screen.getByRole("button", { name: /create product/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/catalog/products", expect.objectContaining({ name: longName })));
  });
});
