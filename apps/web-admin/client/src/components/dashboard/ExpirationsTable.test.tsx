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

  it("truncates a long product/customer name in the table cell and keeps the full value on hover", async () => {
    const longProduct =
      "Netflix Premium 1 Bulan Sharing Private Garansi Full Original Akun Termurah Terpercaya Aman";
    const longCustomer = "customer.with.a.very.long.display.name.that.would.otherwise.overflow.the.table@example.com";
    renderWith([
      { orderId: 8, orderCode: "ORD-BBB", productName: longProduct, customerLabel: longCustomer, remainingDays: 2 },
    ]);
    const productEl = await screen.findByTitle(longProduct);
    expect(productEl).toHaveClass("truncate");
    expect(productEl).toHaveClass("max-w-[240px]");
    expect(productEl).toHaveTextContent(longProduct);

    const customerEl = screen.getByTitle(longCustomer);
    expect(customerEl).toHaveClass("truncate");
    expect(customerEl).toHaveClass("max-w-[200px]");
    expect(customerEl).toHaveTextContent(longCustomer);
  });
});
