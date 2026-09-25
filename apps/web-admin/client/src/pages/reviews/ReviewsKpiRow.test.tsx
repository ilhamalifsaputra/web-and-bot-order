import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReviewsKpiRow } from "./ReviewsKpiRow";

const KPIS = {
  totalReviews: 87,
  avgRating: 4.6,
  pendingReplyCount: 5,
  negativeCount: 2,
  hiddenCount: 1,
  ratingDistribution: { 1: 1, 2: 1, 3: 2, 4: 20, 5: 63 },
};

function renderWith(fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", fetchImpl);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReviewsKpiRow />
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ReviewsKpiRow", () => {
  it("shows the loaded counts", async () => {
    renderWith(vi.fn(async () => jsonResponse(KPIS)));
    await waitFor(() => expect(screen.getByText("87")).toBeInTheDocument());
    expect(screen.getByText("4.6")).toBeInTheDocument();
  });

  it("shows loading skeletons, never a real-looking 0, while the fetch is in flight", async () => {
    let resolveFetch!: (r: Response) => void;
    renderWith(vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));

    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getAllByText("Total Reviews").length).toBeGreaterThan(0);

    resolveFetch(jsonResponse(KPIS));
    await waitFor(() => expect(screen.getByText("87")).toBeInTheDocument());
  });

  it("shows an error message instead of fake zeros when the initial fetch fails", async () => {
    renderWith(vi.fn(async () => jsonResponse({ error: "boom" }, 500)));
    await waitFor(() => expect(screen.getByText(/couldn't load review stats/i)).toBeInTheDocument());
    expect(screen.queryByText("Total Reviews")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
