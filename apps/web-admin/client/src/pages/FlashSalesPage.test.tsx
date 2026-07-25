import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FlashSalesPage } from "./FlashSalesPage";

// The destination route renders the *received* :productId/:denomId params
// (not a fixed string) so a test asserting on this text proves the exact
// values were threaded through, not just that some numeric id matched the
// route pattern.
function DenominationEditSentinel() {
  const { productId, denomId } = useParams();
  return <div>denomination-edit-page:{productId}:{denomId}</div>;
}

// Real Routes (not a mocked useNavigate — no such mock exists elsewhere in
// this codebase; mirrors DenominationEditPage.test.tsx's own convention for
// asserting a `navigate(...)` call landed on the exact expected path): the
// destination route renders a sentinel string, so a test can prove
// navigation actually happened by asserting that sentinel appears, rather
// than just asserting the DropdownMenuItem exists in the document.
function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/flash-sales"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/flash-sales" element={children} />
          <Route path="/catalog/:productId/denominations/:denomId/edit" element={<DenominationEditSentinel />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A live flash sale on an auto-delivery SKU (availableStock non-null) —
// exercises pricing hierarchy, performance, and the progress bar branch.
const AUTO_FLASH_ROW = {
  id: 1,
  name: "Netflix 1 Month",
  price: "50000",
  isActive: true,
  productId: 10,
  productName: "Netflix",
  categoryName: "Streaming",
  flash: {
    discountPercent: "20",
    startsAtDisplay: "21 Jul 2026 18:20",
    endsAtDisplay: "21 Jul 2026 21:00",
    startsAtIso: "2026-07-21T11:20:00.000Z",
    endsAtIso: "2026-07-21T14:00:00.000Z",
    status: "live" as const,
    salePrice: "40000",
    sold: 8,
    revenue: "320000",
    orders: 8,
    availableStock: 2,
  },
};

// A live flash sale on a manual-delivery SKU (availableStock null) — the
// progress column must render "—" even though `flash` is present.
const MANUAL_FLASH_ROW = {
  id: 2,
  name: "Custom Design 1x",
  price: "100000",
  isActive: true,
  productId: 11,
  productName: "Design Services",
  categoryName: null,
  flash: {
    discountPercent: "10",
    startsAtDisplay: "20 Jul 2026 09:00",
    endsAtDisplay: "22 Jul 2026 09:00",
    startsAtIso: "2026-07-20T02:00:00.000Z",
    endsAtIso: "2026-07-22T02:00:00.000Z",
    status: "live" as const,
    salePrice: "90000",
    sold: 3,
    revenue: "270000",
    orders: 3,
    availableStock: null,
  },
};

// No schedule at all — plain price, no Performance/Progress data, and the
// row action menu must NOT offer "End Sale Now".
const NO_FLASH_ROW = {
  id: 3,
  name: "Spotify 1 Month",
  price: "25000",
  isActive: true,
  productId: 12,
  productName: "Spotify",
  categoryName: "Music",
  flash: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select/DropdownMenu use pointer-capture APIs and scrollIntoView —
  // jsdom doesn't implement them (same convention as VouchersPage.test.tsx /
  // OrdersPage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("FlashSalesPage", () => {
  it("renders the merged Product cell (SKU name + product/category secondary line)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ denominations: [AUTO_FLASH_ROW] }));
    render(<FlashSalesPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Netflix 1 Month")).toBeInTheDocument());
    expect(screen.getByText("Netflix · Streaming")).toBeInTheDocument();
  });

  it("renders the pricing hierarchy for a flash row and a plain price for a non-flash row", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ denominations: [AUTO_FLASH_ROW, NO_FLASH_ROW] }),
    );
    render(<FlashSalesPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Netflix 1 Month")).toBeInTheDocument());

    // Flash row: strikethrough original + sale price + -N%.
    expect(screen.getByText("Rp50.000")).toBeInTheDocument();
    expect(screen.getByText("Rp40.000")).toBeInTheDocument();
    expect(screen.getByText("-20%")).toBeInTheDocument();

    // Non-flash row: plain price, no discount badge.
    expect(screen.getByText("Rp25.000")).toBeInTheDocument();
  });

  it('renders "Sold N" / revenue for a flash row, and "—" in Performance for a non-flash row', async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ denominations: [AUTO_FLASH_ROW, NO_FLASH_ROW] }),
    );
    render(<FlashSalesPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Netflix 1 Month")).toBeInTheDocument());

    expect(screen.getByText("Sold 8")).toBeInTheDocument();
    expect(screen.getByText("Rp320.000")).toBeInTheDocument();
    expect(screen.getByText("8 orders")).toBeInTheDocument();

    const rows = screen.getAllByRole("row");
    const rowFor = (name: string) => rows.find((r) => within(r).queryByText(name));
    expect(within(rowFor("Spotify 1 Month")!).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders the progress bar + \"X / Y sold\" for an auto-delivery flash row, and \"—\" when availableStock is null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ denominations: [AUTO_FLASH_ROW, MANUAL_FLASH_ROW] }),
    );
    render(<FlashSalesPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Netflix 1 Month")).toBeInTheDocument());

    // AUTO_FLASH_ROW: sold 8, availableStock 2 -> total 10.
    expect(screen.getByText("8 / 10 sold")).toBeInTheDocument();

    // MANUAL_FLASH_ROW has a schedule (flash present) but no inventory concept.
    const rows = screen.getAllByRole("row");
    const manualRow = rows.find((r) => within(r).queryByText("Custom Design 1x"));
    expect(within(manualRow!).getByText("—")).toBeInTheDocument();
  });

  it('"View SKU" navigates to the denomination edit route', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ denominations: [AUTO_FLASH_ROW] }));
    render(<FlashSalesPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Netflix 1 Month")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for Netflix 1 Month" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("View SKU")).toBeInTheDocument();
    expect(within(menu).getByText("Edit Schedule")).toBeInTheDocument();
    expect(within(menu).getByText("End Sale Now")).toBeInTheDocument();

    // AUTO_FLASH_ROW has productId: 10, id: 1 — clicking "View SKU" must
    // navigate to /catalog/10/denominations/1/edit. The Wrapper's Routes
    // renders the *received* :productId/:denomId as text (not a fixed
    // sentinel), so asserting the exact "10:1" values proves the
    // `navigate(...)` call fired with the right path — not just that some
    // numeric id matched the route pattern (same convention as
    // DenominationEditPage.test.tsx's own navigation assertion).
    await user.click(within(menu).getByText("View SKU"));
    await waitFor(() => expect(screen.getByText("denomination-edit-page:10:1")).toBeInTheDocument());
  });

  it('"End Sale Now" is only offered when row.flash is present, and only appears for flash rows', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ denominations: [AUTO_FLASH_ROW, NO_FLASH_ROW] }),
    );
    render(<FlashSalesPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Spotify 1 Month")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for Spotify 1 Month" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("End Sale Now")).not.toBeInTheDocument();
  });

  it('confirming "End Sale Now" calls the bulk-end endpoint with just that row\'s id, not the whole selected set', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ denominations: [AUTO_FLASH_ROW, MANUAL_FLASH_ROW] }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<FlashSalesPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Netflix 1 Month")).toBeInTheDocument());

    // Select a DIFFERENT row in the bulk checkbox column first, to prove the
    // row action doesn't piggyback on the page's bulk `selected` state.
    await user.click(screen.getByRole("checkbox", { name: /select custom design 1x/i }));

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true, cleared: 1, skipped: 0 }));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ denominations: [] }));

    await user.click(screen.getByRole("button", { name: "Actions for Netflix 1 Month" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("End Sale Now"));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^end now$/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/flash-sales/bulk-end",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ denominationIds: [1] }),
        }),
      ),
    );
  });

  it("renders the four KPI StatCard values from the same counts as before", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        denominations: [
          AUTO_FLASH_ROW,
          { ...MANUAL_FLASH_ROW, flash: { ...MANUAL_FLASH_ROW.flash, status: "scheduled" as const } },
          { ...NO_FLASH_ROW, id: 4, flash: { ...AUTO_FLASH_ROW.flash, status: "ended" as const } },
          NO_FLASH_ROW,
        ],
      }),
    );
    render(<FlashSalesPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Netflix 1 Month")).toBeInTheDocument());

    function statCard(label: string): HTMLElement {
      const match = screen.getAllByText(label).find((el) => el.closest('[data-slot="card"]'));
      return match!.closest('[data-slot="card"]') as HTMLElement;
    }

    expect(within(statCard("Scheduled")).getByText("1")).toBeInTheDocument();
    expect(within(statCard("Running")).getByText("1")).toBeInTheDocument();
    expect(within(statCard("Expired")).getByText("1")).toBeInTheDocument();
    // Discounted SKU counts every row with a non-null `flash` (3 of the 4 rows).
    expect(within(statCard("Discounted SKU")).getByText("3")).toBeInTheDocument();
  });

  it("shows empty state when no denominations", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ denominations: [] }));
    render(<FlashSalesPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no skus found/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<FlashSalesPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
