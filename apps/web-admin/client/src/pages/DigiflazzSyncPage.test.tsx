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
      rawBrand: "Mobile Legends",
      region: null,
      existingProductId: null,
      skus: [
        { buyerSkuCode: "ml100", productName: "ML 100 Diamond", costPrice: "15000", suggestedPrice: "16500" },
      ],
    },
    {
      brand: "Free Fire",
      rawBrand: "Free Fire",
      region: null,
      existingProductId: null,
      skus: [
        { buyerSkuCode: "ff100", productName: "FF 100 Diamond", costPrice: "12000", suggestedPrice: "13000" },
      ],
    },
  ],
};

// A region-split preview: two groups sharing the same rawBrand, distinguished
// by region — the "Mobile Legends" brand mixing multiple countries' pricing
// that Task 2's backend fix now splits before this UI ever sees it.
const REGION_PREVIEW_RESPONSE = {
  groups: [
    {
      brand: "Mobile Legends (Indonesia)",
      rawBrand: "Mobile Legends",
      region: "Indonesia",
      existingProductId: null,
      skus: [
        { buyerSkuCode: "ml100id", productName: "ML 100 Diamond (Indonesia)", costPrice: "15000", suggestedPrice: "16500" },
      ],
    },
    {
      brand: "Mobile Legends (Filipina)",
      rawBrand: "Mobile Legends",
      region: "Filipina",
      existingProductId: 42,
      skus: [
        { buyerSkuCode: "ml100ph", productName: "ML 100 Diamond (Filipina)", costPrice: "16000", suggestedPrice: "17500" },
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

  it("Task 4: renders exactly as before (no region badge) when a group has no region", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await syncWizard(user);

    // No "(...)" region suffix appears next to the brand name for a
    // non-region-split brand.
    const card = screen.getByRole("button", { name: /mobile legends/i });
    expect(card).toHaveTextContent("Mobile Legends — 1 SKU(s), Baru");
    expect(card).not.toHaveTextContent(/mobile legends\s*\(/i);
  });

  it("Task 4: shows the region distinctly on the importable-groups card title when present", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce(REGION_PREVIEW_RESPONSE);
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    await user.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));

    const card = await screen.findByRole("button", { name: /mobile legends \(indonesia\)/i });
    expect(card).toHaveTextContent("Mobile Legends (Indonesia) — 1 SKU(s), Baru");
  });

  it("Task 4: shows the region distinctly on the existing-groups (\"Sudah ada\") list when present", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce(REGION_PREVIEW_RESPONSE);
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    await user.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));

    // The Filipina group has an existingProductId, so it renders in the
    // read-only "Sudah ada" list instead of the importable list.
    await waitFor(() => screen.getByText(/sudah ada/i));
    const item = screen.getByText((_, el) => el?.tagName === "LI" && /mobile legends \(filipina\)/i.test(el.textContent ?? ""));
    expect(item).toHaveTextContent("Mobile Legends (Filipina) — 1 SKU(s)");
  });
});
