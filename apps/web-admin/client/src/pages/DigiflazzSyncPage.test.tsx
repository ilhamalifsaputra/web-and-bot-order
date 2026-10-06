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

// The Sync button first runs the full sync (POST .../sync/run), then fetches
// the preview — so every preview mock below is preceded by this run answer.
const RUN_OK = { ok: true, updated: 0, deactivated: 0, added: 0, reactivated: 0 };
const NO_CREDENTIALS_ERROR = "Digiflazz credentials are not configured. Set them in Settings first.";

async function syncWizard(user: ReturnType<typeof userEvent.setup>) {
  vi.mocked(apiPost).mockResolvedValueOnce(RUN_OK).mockResolvedValueOnce(PREVIEW_RESPONSE);
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

  // I-3: the server reads a retyped price by shape and an untouched suggested
  // price exactly, so each row says which one it is.
  it("marks an untouched suggested price exact and sends a retyped price (16.500,50) for the server to read by shape", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await syncWizard(user);
    await selectCategory(user);
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, brandsImported: 2, denominationsImported: 2 });

    await user.click(screen.getByRole("button", { name: /mobile legends/i }));
    fireEvent.change(screen.getByDisplayValue("16500"), { target: { value: "16.500,50" } });
    const importButton = screen.getByRole("button", { name: /impor terpilih/i });
    expect(importButton).not.toBeDisabled();
    await user.click(importButton);

    await waitFor(() => expect(findApplyCall()).toBeTruthy());
    const [, body] = findApplyCall()!;
    const rows = (body as { brands: Array<{ brand: string; rows: Array<Record<string, unknown>> }> }).brands.flatMap((b) => b.rows);
    const ml = rows.find((r) => r.buyerSkuCode === "ml100")!;
    const ff = rows.find((r) => r.buyerSkuCode === "ff100")!;
    expect(ml).toMatchObject({ price: "16.500,50", costPrice: "15000" });
    expect(ml.exact_fields ?? []).toEqual([]);
    expect(ff).toMatchObject({ price: "13000", exact_fields: ["price"] });
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

  // Task 6: this wizard's per-SKU price input has no label at all beyond the
  // adjacent "Cost <value>" span — now that display currency is a per-user
  // choice elsewhere in the app, that span must say which currency it's in.
  it("shows the cost figure labeled (IDR), disambiguating the currency of the price being edited", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await syncWizard(user);

    await user.click(screen.getByRole("button", { name: /mobile legends/i }));
    expect(screen.getByText("Cost 15000 (IDR)")).toBeInTheDocument();
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
    vi.mocked(apiPost).mockResolvedValueOnce(RUN_OK).mockResolvedValueOnce(REGION_PREVIEW_RESPONSE);
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    await user.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));

    const card = await screen.findByRole("button", { name: /mobile legends \(indonesia\)/i });
    expect(card).toHaveTextContent("Mobile Legends (Indonesia) — 1 SKU(s), Baru");
  });

  it("Task 4: shows the region distinctly on the existing-groups (\"Sudah ada\") list when present", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce(RUN_OK).mockResolvedValueOnce(REGION_PREVIEW_RESPONSE);
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
    vi.mocked(apiPost).mockResolvedValueOnce(RUN_OK).mockResolvedValueOnce(EXISTING_NO_REGION_RESPONSE);
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

describe("DigiflazzSyncPage — Sync runs the full sync before the preview", () => {
  const postedUrls = () => vi.mocked(apiPost).mock.calls.map(([url]) => url);

  it("runs the sync first, then fetches the preview, and shows the run summary without zero parts", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost)
      .mockResolvedValueOnce({ ok: true, updated: 5, deactivated: 1, added: 13, reactivated: 0 })
      .mockResolvedValueOnce(PREVIEW_RESPONSE);
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    await user.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));

    await waitFor(() => screen.getByText(/mobile legends/i));
    expect(postedUrls()).toEqual(["/api/catalog/digiflazz/sync/run", "/api/catalog/digiflazz/sync/preview"]);
    const summary = screen.getByText(/sku baru ditambahkan/i);
    expect(summary).toHaveTextContent("13 SKU baru ditambahkan, 1 dinonaktifkan, 5 harga diperbarui");
    expect(summary).not.toHaveTextContent(/diaktifkan lagi/i);
  });

  it("says the sync was aborted (not 'no change') when the server reports an aborted run", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost)
      .mockResolvedValueOnce({ ...RUN_OK, aborted: true, abortReason: "sharp_change" })
      .mockResolvedValueOnce(PREVIEW_RESPONSE);
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    await user.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));

    await waitFor(() => screen.getByText(/mobile legends/i));
    expect(
      screen.getByText(
        "Sync dibatalkan karena respons Digiflazz tidak wajar; tidak ada yang diubah. Cek koneksi Digiflazz.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/tidak ada perubahan/i)).not.toBeInTheDocument();
  });

  it("says there was no change when every count is zero", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await syncWizard(user);
    expect(screen.getByText(/tidak ada perubahan/i)).toBeInTheDocument();
  });

  it("shows a busy error from the run but still loads the preview", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost)
      .mockRejectedValueOnce(new Error("A Digiflazz sync is already running (the hourly sync or another admin's). Please wait a few minutes and try again."))
      .mockResolvedValueOnce(PREVIEW_RESPONSE);
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    await user.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));

    await waitFor(() => screen.getByText(/mobile legends/i));
    expect(screen.getByText(/already running/i)).toBeInTheDocument();
    expect(postedUrls()).toEqual(["/api/catalog/digiflazz/sync/run", "/api/catalog/digiflazz/sync/preview"]);
  });

  it("skips the preview when the run reports missing Digiflazz credentials", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockRejectedValueOnce(new Error(NO_CREDENTIALS_ERROR));
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    await user.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));

    await waitFor(() => expect(screen.getByText(/credentials are not configured/i)).toBeInTheDocument());
    expect(screen.getAllByText(/credentials are not configured/i)).toHaveLength(1);
    expect(postedUrls()).toEqual(["/api/catalog/digiflazz/sync/run"]);
  });

  it("explains on the \"Sudah ada\" card that existing games are kept up to date automatically", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce(RUN_OK).mockResolvedValueOnce(EXISTING_NO_REGION_RESPONSE);
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    await user.click(screen.getByRole("button", { name: /sync dari digiflazz/i }));

    await waitFor(() => screen.getByText(/sudah ada/i));
    expect(screen.getByText(/setiap jam dan saat anda menekan sync/i)).toBeInTheDocument();
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
      added: 0,
      reactivated: 0,
      abortReason: null,
      finishedAt: new Date().toISOString(),
    });
    await waitFor(() => expect(screen.getByText(/last synced/i)).toBeInTheDocument());
    const message = screen.getByText(/last synced/i);
    expect(message).toHaveTextContent("5");
    expect(message).toHaveTextContent("2");
    expect(message).toHaveTextContent(/just now/i);
  });

  it("includes the added and reactivated counts in the success message", async () => {
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    MockEventSource.instances[0].emit({
      status: "success",
      updated: 5,
      deactivated: 2,
      added: 13,
      reactivated: 3,
      abortReason: null,
      finishedAt: new Date().toISOString(),
    });
    await waitFor(() => expect(screen.getByText(/last synced/i)).toBeInTheDocument());
    const message = screen.getByText(/last synced/i);
    expect(message).toHaveTextContent("13 new SKU(s) added");
    expect(message).toHaveTextContent("3 reactivated");
  });

  it("renders the sharp_change-specific abort message", async () => {
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    MockEventSource.instances[0].emit({
      status: "aborted",
      updated: 0,
      deactivated: 0,
      added: 0,
      reactivated: 0,
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
      added: 0,
      reactivated: 0,
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
      vi.mocked(apiPost)
        .mockResolvedValueOnce(RUN_OK)
        .mockImplementationOnce(
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

describe("DigiflazzSyncPage — fix round: guarded sessionStorage writes + full persistence deps", () => {
  it("does not crash the page when sessionStorage.setItem throws (e.g. private browsing / QuotaExceededError)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // jsdom's sessionStorage isn't a plain Storage.prototype instance
    // (spying on Storage.prototype.setItem doesn't intercept calls made
    // through it), so replace the global binding outright — this is exactly
    // what the component reads via the bare `sessionStorage` identifier.
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
      clear: () => {},
    });

    await syncWizard(user);

    // The page must keep rendering normally — no error boundary swallowing
    // the tree into a generic "Something went wrong" screen.
    expect(screen.getByText(/mobile legends/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync dari digiflazz/i })).toBeInTheDocument();
  });

  it("persists a category/filter change made AFTER the preview loads, not just the fetch-time values", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await syncWizard(user);

    // At this point sessionStorage already holds categoryId: "" and
    // filter: "" from the initial persist alongside the fetched preview.
    await selectCategory(user);
    fireEvent.change(screen.getByPlaceholderText(/filter by game name/i), { target: { value: "Mobile" } });

    await waitFor(() => {
      const raw = sessionStorage.getItem(PREVIEW_STORAGE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!) as { categoryId: string; filter: string };
      expect(parsed.categoryId).toBe("1");
      expect(parsed.filter).toBe("Mobile");
    });
  });
});

describe("DigiflazzSyncPage — Deteksi panel", () => {
  const SUMMARY = {
    detectorStamp: "1.0.0+k3",
    totalRecords: 12,
    resolved: 10,
    ambiguous: 1,
    unknown: 1,
    confidenceBuckets: { "0.90-1.00": 8, "0.75-0.90": 2, "0.50-0.75": 0, "0.00-0.50": 0 },
    overrideHits: 0,
    finishedAt: new Date().toISOString(),
  };
  const OPEN_ISSUE = {
    id: 7,
    status: "unknown",
    reviewStatus: "OPEN",
    reason: "no catalog candidates matched this product name",
    rawInput: JSON.stringify({ productName: "Mystery SKU" }),
    occurrences: 3,
    lastSeenAt: new Date().toISOString(),
  };

  /** Route apiGet by URL: categories for the wizard, plus the two detection
   * endpoints the panel reads. `issues` is read from a mutable holder so a
   * test can change what a refetch (after a resolve/dismiss) returns. */
  function stubDetectionGets(opts: { metrics: unknown; issuesHolder: { current: unknown } }) {
    vi.mocked(apiGet).mockImplementation((url: string) => {
      if (url.startsWith("/api/catalog/detection/metrics")) return Promise.resolve(opts.metrics);
      if (url.startsWith("/api/catalog/detection/issues")) return Promise.resolve(opts.issuesHolder.current);
      return Promise.resolve({ categories: [{ id: 1, name: "Top Up Game" }] });
    });
  }

  it("shows the empty summary and empty queue states before any run", async () => {
    stubDetectionGets({ metrics: { metrics: null }, issuesHolder: { current: { issues: [] } } });
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    expect(await screen.findByText(/deteksi katalog belum pernah dijalankan/i)).toBeInTheDocument();
    expect(await screen.findByText(/tidak ada isu deteksi yang perlu ditinjau/i)).toBeInTheDocument();
  });

  it("renders the run summary counts and the confidence distribution", async () => {
    stubDetectionGets({ metrics: { metrics: SUMMARY }, issuesHolder: { current: { issues: [] } } });
    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    expect(
      await screen.findByText(/10 cocok, 1 ambigu, 1 tidak dikenali dari 12 produk/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/0\.90-1\.00 → 8/)).toBeInTheDocument();
  });

  it("lists an OPEN issue and resolving it POSTs to /resolve then refetches the queue", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const issuesHolder = { current: { issues: [OPEN_ISSUE] } };
    stubDetectionGets({ metrics: { metrics: SUMMARY }, issuesHolder });
    vi.mocked(apiPost).mockResolvedValue({ ok: true });

    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    expect(await screen.findByText(/no catalog candidates matched/i)).toBeInTheDocument();
    expect(screen.getByText(/antrean tinjauan \(1\)/i)).toBeInTheDocument();

    // The resolve refetch should now see an empty queue.
    issuesHolder.current = { issues: [] };
    await user.click(screen.getByRole("button", { name: /^resolve$/i }));

    await waitFor(() =>
      expect(vi.mocked(apiPost)).toHaveBeenCalledWith(
        "/api/catalog/detection/issues/7/resolve",
        {},
      ),
    );
    await waitFor(() =>
      expect(screen.getByText(/tidak ada isu deteksi yang perlu ditinjau/i)).toBeInTheDocument(),
    );
  });

  it("dismissing an OPEN issue POSTs to /dismiss", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const issuesHolder = { current: { issues: [OPEN_ISSUE] } };
    stubDetectionGets({ metrics: { metrics: SUMMARY }, issuesHolder });
    vi.mocked(apiPost).mockResolvedValue({ ok: true });

    render(<DigiflazzSyncPage />, { wrapper: Wrapper });
    await screen.findByText(/no catalog candidates matched/i);
    await user.click(screen.getByRole("button", { name: /^dismiss$/i }));

    await waitFor(() =>
      expect(vi.mocked(apiPost)).toHaveBeenCalledWith(
        "/api/catalog/detection/issues/7/dismiss",
        {},
      ),
    );
  });
});
