import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { OrdersPage } from "./OrdersPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function WrapperAt({ initialEntries, children }: { initialEntries: string[]; children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={qc}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const ELIGIBILITY_NONE = {
  isDelivered: false,
  canAct: false,
  canCredit: false,
  canFulfill: false,
  canReject: false,
  canResend: false,
};

const ORDER_CAN_ACT = {
  id: 1,
  orderCode: "ORD-0001",
  status: "PENDING_VERIFICATION",
  currency: "IDR",
  totalAmount: "50000",
  paymentMethod: "BINANCE_PAY",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdAtDisplay: "2026-01-01",
  user: { id: 10, fullName: "Andi Santoso", username: "andi", telegramId: "555111" },
  items: [{ id: 1, quantity: 1, product: { id: 1, name: "Netflix 1 Month" } }],
  eligibility: { ...ELIGIBILITY_NONE, canAct: true, canReject: true },
};

const ORDER_CAN_FULFILL = {
  id: 2,
  orderCode: "ORD-0002",
  status: "PROCESSING",
  currency: "IDR",
  totalAmount: "75000",
  paymentMethod: "TOKOPAY",
  createdAt: "2026-01-02T00:00:00.000Z",
  createdAtDisplay: "2026-01-02",
  user: { id: 11, fullName: null, username: "budi", telegramId: null },
  items: [
    { id: 2, quantity: 1, product: { id: 2, name: "Spotify 1 Month" } },
    { id: 3, quantity: 2, product: { id: 3, name: "YouTube 1 Month" } },
  ],
  eligibility: { ...ELIGIBILITY_NONE, canFulfill: true, canReject: true },
};

const ORDER_CAN_RESEND = {
  id: 3,
  orderCode: "ORD-0003",
  status: "DELIVERED",
  currency: "USDT",
  totalAmount: "20.25",
  paymentMethod: "WALLET",
  createdAt: "2026-01-03T00:00:00.000Z",
  createdAtDisplay: "2026-01-03",
  user: { id: 12, fullName: "Citra Dewi", username: null, telegramId: "777222" },
  items: [],
  eligibility: { ...ELIGIBILITY_NONE, isDelivered: true, canResend: true },
};

const ORDERS_DATA = {
  orders: [ORDER_CAN_ACT, ORDER_CAN_FULFILL, ORDER_CAN_RESEND],
  total: 3,
  page: 1,
  pageSize: 20,
  hasNext: false,
  statuses: ["PENDING_PAYMENT", "PENDING_VERIFICATION", "PROCESSING", "DELIVERED", "REJECTED", "CANCELLED"],
};

const KPIS_DATA = {
  totalOrders: 67,
  revenueToday: { idr: "1250000", usdt: "20.25", usd: "20.25" },
  awaitingFulfillment: 12,
  processing: 4,
  delivered: 51,
  cancelled: 3,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Routes fetch by URL/method against small per-test overrides — the page
 *  now fires two GET requests on mount (orders list + kpis) whose relative
 *  order isn't guaranteed, so tests match by URL instead of call sequence. */
function mockFetchRouter(overrides: {
  orders?: unknown;
  kpis?: unknown;
  onPost?: (url: string, body: unknown) => unknown;
} = {}) {
  const ordersResponse = overrides.orders ?? ORDERS_DATA;
  const kpisResponse = overrides.kpis ?? KPIS_DATA;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const result = overrides.onPost?.(url, body) ?? { ok: true };
      return jsonResponse(result);
    }
    if (url.startsWith("/api/orders/kpis")) return jsonResponse(kpisResponse);
    return jsonResponse(ordersResponse);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them. Mock all four to prevent unhandled errors when the
  // dropdown opens and focuses the first option (same convention as
  // Pagination.test.tsx / CatalogPage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("OrdersPage", () => {
  it("shows order rows with customer, product-count, payment-method and status columns", async () => {
    mockFetchRouter();
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-0001")).toBeInTheDocument());
    expect(screen.getByText("Andi Santoso")).toBeInTheDocument();
    expect(screen.getByText("Telegram 555111")).toBeInTheDocument();
    expect(screen.getByText("Binance Pay")).toBeInTheDocument();
    expect(screen.getByText("2026-01-01")).toBeInTheDocument();

    // Product Count: single item shows the product name.
    expect(screen.getByText("Netflix 1 Month")).toBeInTheDocument();
    // Product Count: multiple items show "{first} +{n-1}".
    expect(screen.getByText("Spotify 1 Month")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
    // Product Count: zero items shows a dash.
    expect(screen.getByText("Citra Dewi")).toBeInTheDocument();
  });

  it("renders the KPI row from /api/orders/kpis", async () => {
    mockFetchRouter();
    render(<OrdersPage />, { wrapper: Wrapper });

    // The OrderStatusBadge for the DELIVERED fixture row also renders the
    // literal text "Delivered", so scope the label lookup to the one inside
    // a StatCard container to disambiguate.
    function statCard(label: string): HTMLElement {
      const match = screen.getAllByText(label).find((el) => el.closest('[data-slot="card"]'));
      return match!.closest('[data-slot="card"]') as HTMLElement;
    }

    expect(screen.getByText("Total Orders")).toBeInTheDocument();
    await waitFor(() => expect(within(statCard("Total Orders")).getByText("67")).toBeInTheDocument());
    expect(within(statCard("Awaiting Fulfillment")).getByText("12")).toBeInTheDocument();
    expect(within(statCard("Delivered")).getByText("51")).toBeInTheDocument();
    // The inline header stats line (distinct text from the KPI cards).
    expect(screen.getByText(/67 Orders · 12 Awaiting Fulfillment · 4 Processing · 51 Delivered/)).toBeInTheDocument();
  });

  it("shows the empty state with a Refresh action, and Clear Filters only when a filter is active", async () => {
    mockFetchRouter({ orders: { orders: [], total: 0, page: 1, pageSize: 20, hasNext: false, statuses: [] } });
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no orders found/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it("shows Clear Filters in the empty state once a status tab narrows the view", async () => {
    const user = userEvent.setup();
    mockFetchRouter({ orders: { orders: [], total: 0, page: 1, pageSize: 20, hasNext: false, statuses: [] } });
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no orders found/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /^Delivered/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("pre-filters by the ?status= query param on load", async () => {
    const fetchSpy = mockFetchRouter();
    render(
      <WrapperAt initialEntries={["/orders?status=PROCESSING"]}>
        <OrdersPage />
      </WrapperAt>,
    );
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/orders?status=PROCESSING"),
    );
  });

  it("status tabs set the status filter and reset to page 1 (replaces the old Awaiting Fulfillment chip, F-001)", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchRouter();
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-0001")).toBeInTheDocument());

    const allTab = screen.getByRole("button", { name: /^All/ });
    expect(allTab).toHaveAttribute("aria-pressed", "true");

    const processingTab = screen.getByRole("button", { name: /^Processing/ });
    await user.click(processingTab);
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/orders?status=CONFIRMED%2CPAID"),
    );
    expect(processingTab).toHaveAttribute("aria-pressed", "true");
    expect(allTab).toHaveAttribute("aria-pressed", "false");

    await user.click(allTab);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/orders?"));
    expect(allTab).toHaveAttribute("aria-pressed", "true");
  });

  it("the Awaiting tab folds the raw PROCESSING status into the payment-side awaiting statuses", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchRouter();
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-0001")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /^Awaiting$/ }));
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/orders?status=PENDING_PAYMENT%2CPAYMENT_DETECTED%2CCONFIRMING%2CPENDING_VERIFICATION%2CUNDERPAID%2CPROCESSING",
      ),
    );
  });

  it("wires the search box and payment-method filter to the q/paymentMethod params via Apply", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchRouter();
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-0001")).toBeInTheDocument());

    const search = screen.getByPlaceholderText("Search order code, customer or product...");
    await user.type(search, "andi");

    const paymentMethodSelect = screen.getByText("All methods").closest('[role="combobox"]')!;
    await user.click(paymentMethodSelect);
    await user.click(await screen.findByRole("option", { name: "TokoPay" }));

    await user.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/orders?paymentMethod=TOKOPAY&q=andi"),
    );
  });

  it("bulk-selects rows and calls POST /api/orders/bulk-action for Mark Delivered", async () => {
    const user = userEvent.setup();
    let bulkBody: unknown = null;
    const fetchSpy = mockFetchRouter({
      onPost: (url, body) => {
        if (url === "/api/orders/bulk-action") {
          bulkBody = body;
          return { succeeded: [1], failed: [] };
        }
        return { ok: true };
      },
    });
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-0001")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Select order ORD-0001" }));
    // ORD-0002 is PROCESSING (canFulfill, not canAct) — selecting it too
    // proves the bulk bar pre-filters to the eligible subset before sending.
    await user.click(screen.getByRole("checkbox", { name: "Select order ORD-0002" }));

    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /mark delivered/i }));

    await waitFor(() => expect(bulkBody).toEqual({ ids: [1], action: "deliver" }));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/orders/bulk-action",
      expect.objectContaining({ method: "POST" }),
    );
    await waitFor(() => expect(screen.getByText(/1 succeeded, 0 failed/)).toBeInTheDocument());
  });

  it("row-action menu contents vary by eligibility: canAct shows Deliver", async () => {
    const user = userEvent.setup();
    let approveCalled = false;
    mockFetchRouter({
      onPost: (url) => {
        if (url === "/api/orders/1/approve") approveCalled = true;
        return { ok: true };
      },
    });
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-0001")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for ORD-0001" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Deliver")).toBeInTheDocument();
    expect(within(menu).queryByText("Fulfill Manually")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Resend Delivery")).not.toBeInTheDocument();
    expect(within(menu).getByText("Cancel Order")).toBeInTheDocument();

    await user.click(within(menu).getByText("Deliver"));
    await waitFor(() => expect(approveCalled).toBe(true));
  });

  it("row-action menu: canFulfill shows Fulfill Manually and navigates instead of posting", async () => {
    const user = userEvent.setup();
    mockFetchRouter();
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-0002")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for ORD-0002" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Fulfill Manually")).toBeInTheDocument();
    expect(within(menu).queryByText("Deliver")).not.toBeInTheDocument();

    await user.click(within(menu).getByText("Fulfill Manually"));
    // Navigation happens via react-router; assert no POST fired for it.
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/fulfill"),
      expect.anything(),
    );
  });

  it("row-action menu: canResend shows Resend Delivery, and a delivered/non-terminal order has no Cancel Order item", async () => {
    const user = userEvent.setup();
    let resendCalled = false;
    mockFetchRouter({
      onPost: (url) => {
        if (url === "/api/orders/3/resend") resendCalled = true;
        return { ok: true };
      },
    });
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-0003")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for ORD-0003" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Resend Delivery")).toBeInTheDocument();
    // Already DELIVERED — Cancel Order must not be offered.
    expect(within(menu).queryByText("Cancel Order")).not.toBeInTheDocument();

    await user.click(within(menu).getByText("Resend Delivery"));
    await waitFor(() => expect(resendCalled).toBe(true));
  });

  it("row-action Cancel Order opens a reason dialog and posts to /:id/cancel", async () => {
    const user = userEvent.setup();
    let cancelBody: unknown = null;
    mockFetchRouter({
      onPost: (url, body) => {
        if (url === "/api/orders/1/cancel") cancelBody = body;
        return { ok: true };
      },
    });
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-0001")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for ORD-0001" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Cancel Order"));

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText(/cancellation reason/i), "Buyer requested refund");
    await user.click(within(dialog).getByRole("button", { name: /^cancel order$/i }));

    await waitFor(() => expect(cancelBody).toEqual({ reason: "Buyer requested refund" }));
  });

  it("changing the page size resets pagination to page 1", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchRouter({
      orders: { orders: [ORDER_CAN_ACT], total: 120, page: 2, pageSize: 20, hasNext: true, statuses: [] },
    });
    render(
      <WrapperAt initialEntries={["/orders"]}>
        <OrdersPage />
      </WrapperAt>,
    );
    await waitFor(() => expect(screen.getByText("ORD-0001")).toBeInTheDocument());

    // Go to page 2 first so the reset-to-1 behavior is actually observable.
    await user.click(screen.getByRole("button", { name: "Go to page 2" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/orders?page=2"));

    await user.click(screen.getByRole("combobox", { name: /rows per page/i }));
    await user.click(await screen.findByText("50 / page"));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/orders?pageSize=50"));
  });
});
