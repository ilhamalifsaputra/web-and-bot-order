import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrderDetailPage } from "./OrderDetailPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/orders/1"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/orders/:orderId" element={children} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const ORDER_DETAIL_DATA = {
  order: {
    id: 1,
    orderCode: "ORD-0001",
    status: "PENDING_VERIFICATION",
    currency: "IDR",
    totalAmount: "50000",
    createdAt: "2026-01-01T00:00:00.000Z",
    user: { id: 10, fullName: "Andi Santoso", username: "andi", telegramId: "111" },
    items: [
      {
        id: 100,
        quantity: 1,
        unitPrice: "99000",
        product: { id: 5, name: "CapCut Pro 1M" },
        stockItem: null,
      },
    ],
    voucher: null,
  },
  money: {
    currency: "IDR",
    itemsTotal: "50000",
    bulkDiscount: null,
    discount: null,
    walletCredit: null,
    amountMarker: null,
    totalToPay: "50000",
    equivalentIdr: null,
  },
  isDelivered: false,
  canAct: true,
  canCredit: true,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("OrderDetailPage", () => {
  it("shows order detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(ORDER_DETAIL_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    // Wait for data — product name is in the items table td (unique leaf cell)
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());
    // Unit price td has "99000" (different from itemsTotal "50000" to avoid any confusion)
    expect(screen.getByText("99000")).toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
