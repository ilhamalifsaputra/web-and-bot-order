import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OperationCenter } from "./OperationCenter";

function renderWith(ops: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ops })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OperationCenter />
    </QueryClientProvider>,
  );
}

describe("OperationCenter", () => {
  it("renders all five operation cards with their counts as links", async () => {
    renderWith({ pendingPayments: 4, manualReviews: 2, failedDeliveries: 1, ordersProcessing: 3, expiredPayments: 0 });
    await waitFor(() => expect(screen.getByText("Pending Payments")).toBeInTheDocument());
    expect(screen.getByText("Manual Reviews")).toBeInTheDocument();
    expect(screen.getByText("Failed Deliveries")).toBeInTheDocument();
    expect(screen.getByText("Orders Processing")).toBeInTheDocument();
    expect(screen.getByText("Expired Payments")).toBeInTheDocument();
    // Failed Deliveries card links to the payments ledger filtered to delivery failures.
    const failedLink = screen.getByText("Failed Deliveries").closest("a");
    expect(failedLink).toHaveAttribute("href", "/payments?outcome=delivery_failed");
    // Expired Payments has no orders-page filter, so its card is not a link.
    expect(screen.getByText("Expired Payments").closest("a")).toBeNull();
  });
});
