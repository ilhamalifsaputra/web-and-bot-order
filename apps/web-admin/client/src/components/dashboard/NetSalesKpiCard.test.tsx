import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NetSalesKpiCard } from "./NetSalesKpiCard";

function stubKpis(over: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        revenue: { idr: null, usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
        refunds: { idr: null, usdt: null },
        netSales: { idr: null, usdt: null },
        profit: { idr: null, usdt: null },
        orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
        pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
        ...over,
      }),
    })),
  );
}

function renderWithQuery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NetSalesKpiCard />
    </QueryClientProvider>,
  );
}

describe("NetSalesKpiCard", () => {
  it("renders each currency's net figure on its own line, never joined into one string", async () => {
    stubKpis({ netSales: { idr: "52000", usdt: "16.82" } });
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("Rp52.000")).toBeInTheDocument());
    expect(screen.getByText("16.82 USDT")).toBeInTheDocument();
  });

  it("renders a negative net figure in full instead of hiding or clamping it — more refunded today than sold today is a real signal", async () => {
    stubKpis({ netSales: { idr: "-2000", usdt: null } });
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("-Rp2.000")).toBeInTheDocument());
    expect(screen.queryByText("Rp0")).not.toBeInTheDocument();
    // And it says why, so a negative figure reads as explainable rather than broken.
    expect(screen.getByText(/more refunded today than sold today/i)).toBeInTheDocument();
  });

  // Pins the design decision behind the caveat line (Task 6b fix, M1): it names
  // only the currency that is actually negative, instead of colouring the whole
  // CurrencyStack. A rupiah loss sitting beside a USDT gain must never make the
  // currency that is fine read as a loss too.
  it("names only the negative currency, and leaves a positive one beside it unstyled, when the two disagree", async () => {
    stubKpis({ netSales: { idr: "-2000", usdt: "16.82" } });
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("-Rp2.000")).toBeInTheDocument());

    const caveat = screen.getByText(/more refunded today than sold today/i);
    expect(caveat).toHaveTextContent("IDR:");
    expect(caveat.textContent).not.toMatch(/USDT/);

    // The positive figure still renders in full, and neither it nor any
    // ancestor carries the negative-value colour.
    const usdtAmount = screen.getByText("16.82 USDT");
    expect(usdtAmount.className).not.toMatch(/rust|red|danger/);
    expect(usdtAmount.closest(".text-rust")).toBeNull();
  });

  it("leaves the explanation off when every net figure is positive", async () => {
    stubKpis({ netSales: { idr: "52000", usdt: null } });
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("Rp52.000")).toBeInTheDocument());
    expect(screen.queryByText(/more refunded today than sold today/i)).not.toBeInTheDocument();
  });

  it("shows an honest no-net-sales message rather than a fabricated Rp0 when there was no activity", async () => {
    stubKpis({ netSales: { idr: null, usdt: null } });
    renderWithQuery();
    await waitFor(() => expect(screen.getByText("No net sales yet today.")).toBeInTheDocument());
  });

  // The two halves of this figure are bucketed on different columns (the sale
  // on deliveredAt, the payout on executedAt), which is exactly why it can go
  // negative — so the card says so instead of leaving it to be discovered.
  it("states its own basis, including why the figure can be negative", async () => {
    stubKpis({ netSales: { idr: "52000", usdt: null } });
    renderWithQuery();
    await waitFor(() =>
      expect(
        screen.getByText(/Sold today, minus refunds paid out today — a sale counts on the day it was delivered and a refund on the day it is paid out, so this can be negative/),
      ).toBeInTheDocument(),
    );
  });
});
