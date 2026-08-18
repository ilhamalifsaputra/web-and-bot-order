import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DigiflazzSyncPage } from "./DigiflazzSyncPage";
import { apiGet, apiPost } from "../api/client";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/catalog/digiflazz-sync"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/catalog/digiflazz-sync" element={children} />
          <Route path="/catalog" element={<div>catalog-page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const PREVIEW_RESPONSE = {
  groups: [
    {
      brand: "Mobile Legends",
      existingProductId: null,
      skus: [
        { buyerSkuCode: "ml100", productName: "ML 100 Diamond", costPrice: "15000", suggestedPrice: "16500" },
      ],
    },
    {
      brand: "Free Fire",
      existingProductId: null,
      skus: [
        { buyerSkuCode: "ff100", productName: "FF 100 Diamond", costPrice: "12000", suggestedPrice: "13000" },
      ],
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiGet).mockResolvedValue({ categories: [{ id: 1, name: "Top Up Game" }] });
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them (same mocks as DenominationCreatePage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

async function syncWizard(user: ReturnType<typeof userEvent.setup>) {
  vi.mocked(apiPost).mockResolvedValueOnce(PREVIEW_RESPONSE);
  render(<DigiflazzSyncPage />, { wrapper: Wrapper });
  await user.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));
  await waitFor(() => screen.getByText(/mobile legends/i));
}

async function selectCategory(user: ReturnType<typeof userEvent.setup>) {
  // Radix's SelectTrigger doesn't expose "Target category" as an accessible
  // name (the placeholder is a plain visual <span>, not an aria-label) — this
  // page has exactly one combobox, so querying by role alone is unambiguous.
  await user.click(screen.getByRole("combobox"));
  await waitFor(() => screen.getByRole("option", { name: "Top Up Game" }));
  await user.click(screen.getByRole("option", { name: "Top Up Game" }));
}

function findApplyCall() {
  return vi.mocked(apiPost).mock.calls.find(([url]) => url === "/api/catalog/digiflazz/sync/apply");
}

describe("DigiflazzSyncPage", () => {
  it("C1: filtering the brand list to one brand and importing excludes the filtered-out brand, even though its SKUs stay checked", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await syncWizard(user);
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, brandsImported: 1, denominationsImported: 1 });

    // Filter down to Mobile Legends only — Free Fire's card disappears, but
    // (per the default-checked-on-sync behavior) its SKU is still "checked"
    // in state.
    fireEvent.change(screen.getByPlaceholderText(/filter by game name/i), { target: { value: "Mobile" } });
    expect(screen.queryByText(/free fire/i)).not.toBeInTheDocument();

    await selectCategory(user);
    await user.click(screen.getByRole("button", { name: /impor terpilih/i }));

    await waitFor(() => expect(findApplyCall()).toBeTruthy());
    const [, body] = findApplyCall()!;
    const brands = (body as { brands: Array<{ brand: string }> }).brands;
    expect(brands.map((b) => b.brand)).toEqual(["Mobile Legends"]);
  });

  it("C1: importing with an empty filter still includes every checked brand (no over-correction)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await syncWizard(user);
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, brandsImported: 2, denominationsImported: 2 });

    await selectCategory(user);
    await user.click(screen.getByRole("button", { name: /impor terpilih/i }));

    await waitFor(() => expect(findApplyCall()).toBeTruthy());
    const [, body] = findApplyCall()!;
    const brands = (body as { brands: Array<{ brand: string }> }).brands;
    expect(brands.map((b) => b.brand)).toEqual(["Mobile Legends", "Free Fire"]);
  });

  it("I10: a checked row with an invalid price disables Import and shows the hint; fixing the price re-enables it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await syncWizard(user);
    await selectCategory(user);

    await user.click(screen.getByRole("button", { name: /mobile legends/i }));
    const priceInput = screen.getByDisplayValue("16500");
    fireEvent.change(priceInput, { target: { value: "0" } });

    const importButton = screen.getByRole("button", { name: /impor terpilih/i });
    expect(importButton).toBeDisabled();
    expect(screen.getByText(/fix the highlighted price/i)).toBeInTheDocument();

    fireEvent.change(priceInput, { target: { value: "17000" } });
    expect(importButton).not.toBeDisabled();
    expect(screen.queryByText(/fix the highlighted price/i)).not.toBeInTheDocument();
  });

  it("I10: unchecking the invalid row also re-enables Import", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await syncWizard(user);
    await selectCategory(user);

    await user.click(screen.getByRole("button", { name: /mobile legends/i }));
    const priceInput = screen.getByDisplayValue("16500");
    fireEvent.change(priceInput, { target: { value: "0" } });

    const importButton = screen.getByRole("button", { name: /impor terpilih/i });
    expect(importButton).toBeDisabled();

    await user.click(screen.getByRole("checkbox"));
    expect(importButton).not.toBeDisabled();
  });

  it("I13: the brand-group expander is a real button with aria-expanded, and is keyboard-operable", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await syncWizard(user);

    const expander = screen.getByRole("button", { name: /mobile legends/i });
    expect(expander.tagName).toBe("BUTTON");
    expect(expander).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/ml 100 diamond/i)).not.toBeInTheDocument();

    expander.focus();
    await user.keyboard("{Enter}");
    expect(expander).toHaveAttribute("aria-expanded", "true");
    // The row's product name renders twice (a mobile-only span and a
    // desktop-only span, toggled by a Tailwind breakpoint class jsdom
    // doesn't evaluate) — getAllByText, not getByText, is correct here.
    expect(screen.getAllByText(/ml 100 diamond/i).length).toBeGreaterThan(0);

    await user.click(expander);
    expect(expander).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/ml 100 diamond/i)).not.toBeInTheDocument();
  });
});
