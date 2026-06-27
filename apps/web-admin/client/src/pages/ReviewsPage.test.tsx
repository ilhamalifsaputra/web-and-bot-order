import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReviewsPage } from "./ReviewsPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const REVIEW = {
  id: 1,
  rating: 5,
  comment: "Bagus banget!",
  hidden: false,
  createdAt: "2026-06-26T10:00:00.000Z",
  user: { username: "andi", fullName: "Andi Santoso" },
  denomination: { name: "Netflix 1 Month" },
};

beforeEach(() => { vi.restoreAllMocks(); });

describe("ReviewsPage", () => {
  it("renders review rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ reviews: [REVIEW], total: 1, page: 1, hasNext: false, summaries: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Bagus banget!")).toBeInTheDocument());
    expect(screen.getByText(/andi santoso/i)).toBeInTheDocument();
  });

  it("shows empty state when no reviews", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ reviews: [], total: 0, page: 1, hasNext: false, summaries: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no reviews/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
