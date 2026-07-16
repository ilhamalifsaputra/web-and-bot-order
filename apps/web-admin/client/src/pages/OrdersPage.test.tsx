import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrdersPage } from "./OrdersPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function WrapperAt({ initialEntries, children }: { initialEntries: string[]; children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const ORDER = {
  id: 1,
  orderCode: "ORD-0001",
  status: "PENDING_VERIFICATION",
  currency: "IDR",
  totalAmount: "50000",
  paymentMethod: "BINANCE_PAY",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdAtDisplay: "2026-01-01",
  user: { id: 10, fullName: "Andi Santoso", username: "andi" },
};

const ORDERS_DATA = {
  orders: [ORDER],
  total: 1,
  page: 1,
  pageSize: 50,
  hasNext: false,
  statuses: ["PENDING_PAYMENT", "PENDING_VERIFICATION", "DELIVERED", "REJECTED"],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("OrdersPage", () => {
  it("shows order rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(ORDERS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-0001")).toBeInTheDocument());
    expect(screen.getByText("Andi Santoso")).toBeInTheDocument();
    expect(screen.getByText("BINANCE_PAY")).toBeInTheDocument();
    expect(screen.getByText("2026-01-01")).toBeInTheDocument(); // createdAtDisplay
  });

  it("shows a context-aware empty state (no filter active) when there are no orders at all (F-016)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ orders: [], total: 0, page: 1, pageSize: 50, hasNext: false, statuses: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no orders yet/i)).toBeInTheDocument());
    // No filter is active, so there's nothing to "adjust" — the old generic
    // copy must not appear.
    expect(screen.queryByText(/no orders found/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it("shows the 'no orders match filters' empty state (with Clear filters) when a filter narrows an empty result (F-016)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ orders: [], total: 0, page: 1, pageSize: 50, hasNext: false, statuses: ["PENDING_PAYMENT", "DELIVERED"] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(
      <WrapperAt initialEntries={["/orders?status=DELIVERED"]}>
        <OrdersPage />
      </WrapperAt>,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/orders?status=DELIVERED"));
    await waitFor(() => expect(screen.getByText(/no orders found/i)).toBeInTheDocument());
    expect(screen.getByText(/try adjusting your filters/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument();
    expect(screen.queryByText(/no orders yet/i)).not.toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<OrdersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("pre-filters by the ?status= query param on load", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(ORDERS_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    render(
      <WrapperAt initialEntries={["/orders?status=PROCESSING"]}>
        <OrdersPage />
      </WrapperAt>,
    );
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/orders?status=PROCESSING"),
    );
  });

  it("the Awaiting Fulfillment quick-filter chip toggles the PROCESSING status filter and shows the fulfillment-queue count (F-001)", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/dashboard/operations")) {
        return new Response(
          JSON.stringify({
            pendingPayments: 0,
            manualReviews: 0,
            failedDeliveries: 0,
            ordersProcessing: 0,
            expiredPayments: 0,
            awaitingFulfillment: 7,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(ORDERS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    render(<OrdersPage />, { wrapper: Wrapper });

    const chip = await screen.findByRole("button", { name: /Awaiting Fulfillment/ });
    await waitFor(() => expect(chip).toHaveTextContent("7")); // fulfillment-queue badge count, moved off the removed nav item
    expect(chip).toHaveAttribute("aria-pressed", "false");

    await user.click(chip);
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/orders?status=PROCESSING"),
    );
    expect(chip).toHaveAttribute("aria-pressed", "true");

    await user.click(chip); // click again clears the filter
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/orders?"));
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });
});
