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

  it("labels the series so the y-axis is never a bare number: currency for revenue, order scope for orders", async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText("Delivered revenue (IDR) · per delivery day")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Combined" }));
    await waitFor(() =>
      expect(screen.getByText("Delivered revenue (IDR equivalent) · per delivery day")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Orders" }));
    // Orders + Combined is the sum over both currencies (the server does the summing).
    await waitFor(() =>
      expect(screen.getByText("Delivered orders (all currencies) · per delivery day")).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/analytics?range=7d&currency=combined&metric=orders",
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("button", { name: "USDT" }));
    await waitFor(() =>
      expect(screen.getByText("Delivered orders (paid in USDT) · per delivery day")).toBeInTheDocument(),
    );
  });
});
