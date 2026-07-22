import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { ReviewsPage } from "./ReviewsPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const REVIEW = {
  id: 1,
  rating: 5,
  comment: "Bagus banget!",
  hidden: false,
  createdAt: "2026-06-26T10:00:00.000Z",
  createdAtDisplay: "2026-06-26",
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
    expect(screen.getByText("2026-06-26")).toBeInTheDocument(); // createdAtDisplay, not a browser-locale computation
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

  it("hides a review via /api/reviews/:id/hide and refetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ reviews: [REVIEW], total: 1, page: 1, hasNext: false, summaries: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, hidden: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ reviews: [{ ...REVIEW, hidden: true }], total: 1, page: 1, hasNext: false, summaries: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/reviews/1/hide",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument());
  });

  it("shows a toast when hiding a review fails (previously silently swallowed)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ reviews: [REVIEW], total: 1, page: 1, hasNext: false, summaries: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Review not found." }), { status: 404, headers: { "Content-Type": "application/json" } }),
    );
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));

    expect(await screen.findByText("Review not found.")).toBeInTheDocument();
  });
});
