import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SalesAnalyticsCard } from "./SalesAnalyticsCard";

// jsdom doesn't implement ResizeObserver; stub it so ResponsiveContainer
// doesn't throw when mounting in the test environment.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const fetchMock = vi.fn(async (_url: string) => ({
  ok: true,
  json: async () => [
    { day: "2026-06-24", value: "1000" },
    { day: "2026-06-25", value: "2000" },
  ],
}));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SalesAnalyticsCard />
    </QueryClientProvider>,
  );
}

describe("SalesAnalyticsCard", () => {
  it("requests the default 7d / idr / revenue series on first render", async () => {
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/analytics?range=7d&currency=idr&metric=revenue",
      expect.anything(),
    );
  });

  it("refetches with new params when a filter button is clicked", async () => {
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "30d" }));
    fireEvent.click(screen.getByRole("button", { name: "Orders" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dashboard/analytics?range=30d&currency=idr&metric=orders",
        expect.anything(),
      ),
    );
  });

  // Financial Ledger M6, Task 6c — calendar ranges and the Profit metric.
  it("offers Week/Month/Year alongside the two rolling day windows, and asks for the calendar series", async () => {
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    for (const label of ["7d", "30d", "Week", "Month", "Year"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dashboard/analytics?range=month&currency=idr&metric=revenue",
        expect.anything(),
      ),
    );
  });

  it("hides the Combined currency while Profit is selected — there is no combined-profit figure", async () => {
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Combined" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Profit" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Combined" })).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/analytics?range=7d&currency=idr&metric=profit",
      expect.anything(),
    );
  });

  it("falls back to IDR when Profit is picked while Combined was selected, instead of requesting a combined profit series", async () => {
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Combined" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dashboard/analytics?range=7d&currency=combined&metric=revenue",
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Profit" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dashboard/analytics?range=7d&currency=idr&metric=profit",
        expect.anything(),
      ),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/dashboard/analytics?range=7d&currency=combined&metric=profit",
      expect.anything(),
    );
  });

  it("shows the empty state rather than a flat zero line when every bucket's profit is unknown", async () => {
    // `null` is the crud layer's "no cost-known sale in this bucket" — plotting
    // it through Number() would draw a fabricated Rp0 for each period.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { day: "2026-W37", value: null },
          { day: "2026-W38", value: null },
        ],
      })),
    );
    renderCard();
    await waitFor(() => expect(screen.getByText("No data for this range.")).toBeInTheDocument());
  });
});
