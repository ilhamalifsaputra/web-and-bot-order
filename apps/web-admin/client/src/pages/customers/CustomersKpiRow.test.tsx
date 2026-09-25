import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CustomersKpiRow } from "./CustomersKpiRow";

const KPIS = {
  totalCustomers: 120,
  newToday: 4,
  activeToday: 15,
  returningCustomers: 60,
  totalRevenue: { idr: "1000000", usdt: null },
};

function renderWith(fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", fetchImpl);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CustomersKpiRow />
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("CustomersKpiRow", () => {
  it("shows the loaded counts", async () => {
    renderWith(vi.fn(async () => jsonResponse(KPIS)));
    await waitFor(() => expect(screen.getByText("120")).toBeInTheDocument());
    expect(screen.getByText("60")).toBeInTheDocument();
  });

  it("shows loading skeletons, never a real-looking 0, while the fetch is in flight", async () => {
    let resolveFetch!: (r: Response) => void;
    renderWith(vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));

    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getAllByText("Total Customers").length).toBeGreaterThan(0);

    resolveFetch(jsonResponse(KPIS));
    await waitFor(() => expect(screen.getByText("120")).toBeInTheDocument());
  });

  it("shows an error message instead of fake zeros when the initial fetch fails", async () => {
    renderWith(vi.fn(async () => jsonResponse({ error: "boom" }, 500)));
    await waitFor(() => expect(screen.getByText(/couldn't load customer stats/i)).toBeInTheDocument());
    expect(screen.queryByText("Total Customers")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
