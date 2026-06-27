import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecentOrdersTable } from "./RecentOrdersTable";

function renderWith(rows: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecentOrdersTable />
    </QueryClientProvider>,
  );
}

describe("RecentOrdersTable", () => {
  it("formats each order's amount in its own currency — a USDT order never shows Rp", async () => {
    renderWith([
      { orderId: 1, orderCode: "ORD-IDR", productLabel: "Netflix", customerLabel: "a", amount: "54000", currency: "IDR", status: "DELIVERED", createdAt: "2026-06-25T03:00:00.000Z" },
      { orderId: 2, orderCode: "ORD-USDT", productLabel: "Spotify", customerLabel: "b", amount: "3.43", currency: "USDT", status: "PENDING_VERIFICATION", createdAt: "2026-06-25T04:00:00.000Z" },
    ]);
    await waitFor(() => expect(screen.getByText("Rp54.000")).toBeInTheDocument());
    expect(screen.getByText("3.43 USDT")).toBeInTheDocument();
    expect(screen.queryByText("Rp3")).not.toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument(); // StatusBadge label
  });

  it("shows an empty state when there are no recent orders", async () => {
    renderWith([]);
    await waitFor(() => expect(screen.getByText(/no orders yet/i)).toBeInTheDocument());
  });
});
