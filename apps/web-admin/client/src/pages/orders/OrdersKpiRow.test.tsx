import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AWAITING_FULFILLMENT_HINT } from "../../lib/awaitingFulfillment";
import { OrdersKpiRow } from "./OrdersKpiRow";

const KPIS = {
  totalOrders: 42,
  revenueToday: { idr: "500000", usdt: null },
  awaitingFulfillment: 3,
  processing: 2,
  delivered: 30,
  cancelled: 1,
};

function renderWith(fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", fetchImpl);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OrdersKpiRow />
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("OrdersKpiRow", () => {
  it("shows the loaded counts", async () => {
    renderWith(vi.fn(async () => jsonResponse(KPIS)));
    await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument());
    expect(screen.getByText("30")).toBeInTheDocument();
  });

  it("explains Awaiting Fulfillment with the Operation Center wording (in-flight provider orders are not counted)", async () => {
    renderWith(vi.fn(async () => jsonResponse(KPIS)));
    await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument());
    expect(screen.getByText("Awaiting Fulfillment")).toHaveAttribute("title", AWAITING_FULFILLMENT_HINT);
    expect(AWAITING_FULFILLMENT_HINT).toContain("provider are not counted");
  });

  it("shows loading skeletons, never a real-looking 0, while the fetch is in flight", async () => {
    let resolveFetch!: (r: Response) => void;
    renderWith(vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));

    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getAllByText("Total Orders").length).toBeGreaterThan(0);

    resolveFetch(jsonResponse(KPIS));
    await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument());
  });

  it("shows an error message instead of fake zeros when the initial fetch fails", async () => {
    renderWith(vi.fn(async () => jsonResponse({ error: "boom" }, 500)));
    await waitFor(() => expect(screen.getByText(/couldn't load order stats/i)).toBeInTheDocument());
    expect(screen.queryByText("Total Orders")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
