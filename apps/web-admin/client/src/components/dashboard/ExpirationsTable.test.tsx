import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExpirationsTable } from "./ExpirationsTable";

function renderWith(rows: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ExpirationsTable />
    </QueryClientProvider>,
  );
}

describe("ExpirationsTable", () => {
  it("lists upcoming expirations with remaining days, each linking to its order", async () => {
    renderWith([
      { orderId: 7, orderCode: "ORD-AAA", productName: "Netflix 1M", customerLabel: "buyer", remainingDays: 1 },
    ]);
    await waitFor(() => expect(screen.getByText("Netflix 1M")).toBeInTheDocument());
    expect(screen.getByText("buyer")).toBeInTheDocument();
    expect(screen.getByText(/1 day/)).toBeInTheDocument();
    expect(screen.getByText("ORD-AAA").closest("a")).toHaveAttribute("href", "/orders/7");
  });

  it("shows an empty state when nothing is expiring soon", async () => {
    renderWith([]);
    await waitFor(() => expect(screen.getByText(/no upcoming expirations/i)).toBeInTheDocument());
  });
});
