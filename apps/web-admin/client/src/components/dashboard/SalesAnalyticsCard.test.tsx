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
});
