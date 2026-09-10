import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DigiflazzSyncPage } from "./DigiflazzSyncPage";
import { apiGet, apiPost } from "../api/client";

const PREVIEW_STORAGE_KEY = "digiflazz-sync-preview";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

// The page now always opens an SSE connection for the sync-status card on
// mount (useDigiflazzSyncStatus), so every test in this file — not just the
// ones exercising the card — needs EventSource stubbed, or the wizard tests
// would throw on a real EventSource constructor jsdom doesn't implement.
class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string, _opts?: { withCredentials?: boolean }) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

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

// An existing group (already imported) with region: null — verifies no visual
// regression in the "Sudah ada" list for non-region-split brands.
const EXISTING_NO_REGION_RESPONSE = {
  groups: [
    {
      brand: "Mobile Legends",
      rawBrand: "Mobile Legends",
      region: null,
      existingProductId: 42,
      skus: [
        { buyerSkuCode: "ml100", productName: "ML 100 Diamond", costPrice: "15000", suggestedPrice: "16500" },
      ],
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  vi.mocked(apiGet).mockResolvedValue({ categories: [{ id: 1, name: "Top Up Game" }] });
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them (same mocks as DenominationCreatePage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal("EventSource", MockEventSource);
  MockEventSource.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function syncWizard(user: ReturnType<typeof userEvent.setup>) {
  vi.mocked(apiPost).mockResolvedValueOnce(PREVIEW_RESPONSE);
  const utils = render(<DigiflazzSyncPage />, { wrapper: Wrapper });
  await user.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));
  await waitFor(() => screen.getByText(/mobile legends/i));
  return utils;
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

  it("Task 4: renders exactly as before (no region badge) when an existing group has no region", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce(EXISTING_NO_REGION_RESPONSE);
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    await user.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));

    // An existing group with region: null renders in the read-only "Sudah ada"
    // list with no region badge, just like the new-groups card test above.
    await waitFor(() => screen.getByText(/sudah ada/i));
    const item = screen.getByText((_, el) => el?.tagName === "LI" && /mobile legends/i.test(el.textContent ?? ""));
    expect(item).toHaveTextContent("Mobile Legends — 1 SKU(s)");
    expect(item).not.toHaveTextContent(/mobile legends\s*\(/i);
  });
});

describe("DigiflazzSyncPage — hourly sync status card", () => {
  it("renders the loading state before any push arrives", () => {
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    expect(screen.getByText(/loading sync status/i)).toBeInTheDocument();
  });

  it("renders the never-synced empty state when the stream pushes null", async () => {
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    MockEventSource.instances[0].emit(null);
    await waitFor(() => expect(screen.getByText(/never been auto-synced/i)).toBeInTheDocument());
  });

  it("renders the success message with counts and a relative time when the stream pushes a success status", async () => {
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    MockEventSource.instances[0].emit({
      status: "success",
      updated: 5,
      deactivated: 2,
      abortReason: null,
      finishedAt: new Date().toISOString(),
    });
    await waitFor(() => expect(screen.getByText(/last synced/i)).toBeInTheDocument());
    const message = screen.getByText(/last synced/i);
    expect(message).toHaveTextContent("5");
    expect(message).toHaveTextContent("2");
    expect(message).toHaveTextContent(/just now/i);
  });

  it("renders the sharp_change-specific abort message", async () => {
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    MockEventSource.instances[0].emit({
      status: "aborted",
      updated: 0,
      deactivated: 0,
      abortReason: "sharp_change",
      finishedAt: new Date().toISOString(),
    });
    await waitFor(() =>
      expect(screen.getByText(/too many prices moved sharply/i)).toBeInTheDocument(),
    );
  });

  it("renders the no_usable_rows-specific abort message", async () => {
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    MockEventSource.instances[0].emit({
      status: "aborted",
      updated: 0,
      deactivated: 0,
      abortReason: "no_usable_rows",
      finishedAt: new Date().toISOString(),
    });
    await waitFor(() =>
      expect(screen.getByText(/supplier returned no usable price data/i)).toBeInTheDocument(),
    );
  });

  it("still renders the existing wizard UI alongside the new card", () => {
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    expect(screen.getByRole("button", { name: /sync dari digiflazz/i })).toBeInTheDocument();
  });
});

describe("DigiflazzSyncPage — preview persistence and elapsed-time counter", () => {
  it("Task 1: persists the fetched preview across an unmount/remount without re-fetching", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { unmount } = await syncWizard(user);

    unmount();
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });

    expect(screen.getByText(/mobile legends/i)).toBeInTheDocument();
    const previewCalls = vi
      .mocked(apiPost)
      .mock.calls.filter(([url]) => url === "/api/catalog/digiflazz/sync/preview");
    expect(previewCalls.length).toBe(1);
  });

  it("Task 1: clears the persisted preview after a successful import", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { unmount } = await syncWizard(user);
    await selectCategory(user);
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, brandsImported: 2, denominationsImported: 2 });

    await user.click(screen.getByRole("button", { name: /impor terpilih/i }));
    await waitFor(() => expect(findApplyCall()).toBeTruthy());
    expect(sessionStorage.getItem(PREVIEW_STORAGE_KEY)).toBeNull();

    unmount();
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });

    expect(screen.queryByText(/mobile legends/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync dari digiflazz/i })).toBeInTheDocument();
  });

  it("Task 1: shows a live elapsed-seconds count on the button while syncing, then reverts once done", async () => {
    vi.useFakeTimers();
    try {
      let resolvePreview: (value: typeof PREVIEW_RESPONSE) => void = () => {};
      vi.mocked(apiPost).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePreview = resolve;
          }),
      );
      render(<DigiflazzSyncPage />, { wrapper: Wrapper });

      fireEvent.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByRole("button", { name: /syncing.*1s/i })).toBeInTheDocument();

      await act(async () => {
        resolvePreview(PREVIEW_RESPONSE);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("button", { name: /sync dari digiflazz/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
