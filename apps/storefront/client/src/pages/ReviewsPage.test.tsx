import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReviewsPage from "./ReviewsPage";
import { apiGet, apiPost } from "../api/client";
import type { ReviewsData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const reviewsData: ReviewsData = {
  pending: [{ order_id: 1, code: "ORD1", product_id: 9, product_name: "Netflix" }],
  reviews: [
    { product_name: "Spotify", rating: 4, comment: "Great", created_at_display: "2026-07-01" },
  ],
};

function renderReviews(respond: () => unknown = () => reviewsData) {
  (apiGet as Mock).mockImplementation(async () => respond());
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/account/reviews"]}>
        <Routes>
          <Route path="/account/reviews" element={<ReviewsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ReviewsPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders the pending-review list and the already-submitted reviews", async () => {
    renderReviews();
    expect(await screen.findByText("Waiting for your review")).toBeInTheDocument();
    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.getByText("ORD1")).toBeInTheDocument();
    expect(screen.getByText("Spotify")).toBeInTheDocument();
    expect(screen.getByText("Great")).toBeInTheDocument();
  });

  it("submits the chosen rating and comment, then refetches", async () => {
    renderReviews();
    await screen.findByText("Netflix");
    fireEvent.change(screen.getByLabelText("Your rating"), { target: { value: "3" } });
    fireEvent.change(screen.getByPlaceholderText("How was the product? (optional)"), {
      target: { value: "Decent" },
    });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Send review" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/reviews", {
        order_id: 1,
        product_id: 9,
        rating: 3,
        comment: "Decent",
      }),
    );
    // Refetch after a successful submit.
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });

  // STO-016: the empty state used to be a dead end — it now offers a way
  // back to the catalog.
  it("shows the empty state with a Continue shopping CTA when there are no reviews yet", async () => {
    renderReviews(() => ({ pending: [], reviews: [] }));
    expect(await screen.findByText("You haven't reviewed anything yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/");
  });
});
