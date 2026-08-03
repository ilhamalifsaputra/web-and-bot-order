import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// Fixed shape as returned by GET /api/reviews (apps/web-admin/src/routes/api/reviews.ts):
// the joined denomination is returned under `product`, never `denomination` —
// the earlier ReviewsPage.tsx read `r.denomination?.name`, which always fell
// back to "—" since the API response never had that key. This fixture uses
// `product` throughout so a regression back to `denomination` fails loudly.
const REVIEW = {
  id: 1,
  userId: 10,
  orderId: 100,
  productId: 5,
  rating: 5,
  comment: "Bagus banget!",
  hidden: false,
  createdAt: "2026-06-26T10:00:00.000Z",
  createdAtDisplay: "2026-06-26",
  status: "PENDING_REPLY",
  sentiment: "POSITIVE",
  adminReply: null,
  repliedAt: null,
  user: { fullName: "Andi Santoso", username: "andi", loginUsername: null },
  product: { name: "Netflix 1 Month" },
};

const REVIEWS_DATA = {
  reviews: [REVIEW],
  total: 1,
  page: 1,
  hasNext: false,
  summaries: [{ productId: 5, productName: "Netflix 1 Month", count: 1, hiddenCount: 0, avg: 5 }],
};

const KPIS_DATA = {
  totalReviews: 10,
  avgRating: 4.5,
  pendingReplyCount: 3,
  negativeCount: 1,
  hiddenCount: 2,
  ratingDistribution: { 1: 0, 2: 1, 3: 1, 4: 2, 5: 6 },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Routes fetch by URL/method — the page fires two GET requests on mount
 *  (reviews list + kpis) whose relative order isn't guaranteed, so tests
 *  match by URL instead of call sequence (mirrors UsersPage.test.tsx's
 *  mockFetchRouter). `reviews`/`kpis` may be given as thunks so a mutation
 *  test can make a later GET reflect state changed by an earlier POST. */
function mockFetchRouter(overrides: {
  reviews?: () => unknown;
  kpis?: () => unknown;
  onPost?: (url: string, body: unknown) => unknown;
  onDelete?: (url: string) => unknown;
} = {}) {
  const reviewsFn = overrides.reviews ?? (() => REVIEWS_DATA);
  const kpisFn = overrides.kpis ?? (() => KPIS_DATA);
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const result = overrides.onPost?.(url, body) ?? { ok: true };
      return jsonResponse(result);
    }
    if (method === "DELETE") {
      const result = overrides.onDelete?.(url) ?? { ok: true };
      return jsonResponse(result);
    }
    if (url.startsWith("/api/reviews/kpis")) return jsonResponse(kpisFn());
    return jsonResponse(reviewsFn());
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select/DropdownMenu use pointer-capture APIs and scrollIntoView —
  // jsdom doesn't implement them (same convention as UsersPage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, id = 1) {
  await user.click(screen.getByRole("button", { name: new RegExp(`actions for review #${id}`, "i") }));
  return screen.findByRole("menu");
}

describe("ReviewsPage", () => {
  it("renders review rows with the joined product name (denomination→product bug fixed)", async () => {
    mockFetchRouter();
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Bagus banget!")).toBeInTheDocument());
    expect(screen.getByText("Andi Santoso")).toBeInTheDocument();
    expect(screen.getByText("2026-06-26")).toBeInTheDocument(); // createdAtDisplay, not a browser-locale computation

    // "Netflix 1 Month" also appears in the Product Ratings widget (fed by
    // the same `summaries` array) — scope to the review's own table row to
    // confirm the Product *column* renders it via row.product.name, not the
    // old row.denomination (which was always undefined).
    const row = screen.getByText("Bagus banget!").closest("tr")!;
    expect(within(row).getByText("Netflix 1 Month")).toBeInTheDocument();
  });

  it("shows a relative 'Replied …' line in the Activity column for a recently-replied review", async () => {
    const recentReply = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    mockFetchRouter({
      reviews: () => ({
        ...REVIEWS_DATA,
        reviews: [{ ...REVIEW, adminReply: "Thanks!", repliedAt: recentReply, status: "REPLIED" }],
      }),
    });
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Bagus banget!")).toBeInTheDocument());

    expect(screen.getByText("Replied 2 hours ago")).toBeInTheDocument();
  });

  it("omits the Activity 'Replied …' line rather than rendering a raw ISO timestamp once a reply is over 30 days old", async () => {
    const oldReply = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    mockFetchRouter({
      reviews: () => ({
        ...REVIEWS_DATA,
        reviews: [{ ...REVIEW, adminReply: "Thanks!", repliedAt: oldReply, status: "REPLIED" }],
      }),
    });
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Bagus banget!")).toBeInTheDocument());

    // formatRelativeTime falls back to its `display` argument past 30 days —
    // this page has no server-formatted repliedAtDisplay to pass, so the old
    // (buggy) code rendered the raw ISO string here. The fix omits the line
    // entirely in that case instead. Match on "Replied " (trailing space, a
    // real prefix with content after it) rather than bare /replied/i, which
    // would also match the row's own REPLIED reply-status StatusBadge
    // ("Replied" with no trailing text) and false-positive.
    expect(screen.queryByText(/^Replied /)).not.toBeInTheDocument();
    expect(screen.queryByText(oldReply)).not.toBeInTheDocument();
  });

  it("shows 'No reviews yet' when genuinely empty", async () => {
    mockFetchRouter({ reviews: () => ({ reviews: [], total: 0, page: 1, hasNext: false, summaries: [] }) });
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("No reviews yet")).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("renders the KPI row and quick-filters to Pending Reply on click", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchRouter();
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Bagus banget!")).toBeInTheDocument());

    expect(screen.getByText("Total Reviews")).toBeInTheDocument();
    expect(screen.getByText("Average Rating")).toBeInTheDocument();
    expect(screen.getByText("4.5")).toBeInTheDocument(); // avgRating.toFixed(1)

    fetchSpy.mockClear();
    await user.click(screen.getByRole("button", { name: /pending reply/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/reviews?status=PENDING_REPLY", { credentials: "include" }),
    );
  });

  it("hides a review via the dropdown's Hide action (moved off the standalone button) and refetches", async () => {
    const user = userEvent.setup();
    let hidden = false;
    const fetchSpy = mockFetchRouter({
      reviews: () => ({ ...REVIEWS_DATA, reviews: [{ ...REVIEW, hidden }] }),
      onPost: (url, body) => {
        if (url === "/api/reviews/1/hide") {
          hidden = (body as { hidden: boolean }).hidden;
          return { ok: true, hidden };
        }
        return { ok: true };
      },
    });
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Bagus banget!")).toBeInTheDocument());

    const menu = await openRowMenu(user);
    await user.click(within(menu).getByText("Hide"));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/reviews/1/hide", expect.objectContaining({ method: "POST" })),
    );
    await waitFor(() => expect(screen.getByText("Review hidden.")).toBeInTheDocument());

    const menu2 = await openRowMenu(user);
    expect(within(menu2).getByText("Unhide")).toBeInTheDocument();
  });

  it("shows a toast when hiding a review fails (previously silently swallowed)", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url === "/api/reviews/1/hide") {
        return jsonResponse({ error: "Review not found." }, 404);
      }
      if (url.startsWith("/api/reviews/kpis")) return jsonResponse(KPIS_DATA);
      return jsonResponse(REVIEWS_DATA);
    });
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Bagus banget!")).toBeInTheDocument());

    const menu = await openRowMenu(user);
    await user.click(within(menu).getByText("Hide"));

    expect(await screen.findByText("Review not found.")).toBeInTheDocument();
  });

  it("Reply dialog happy path: sends a reply via POST /api/reviews/:id/reply and shows a success toast", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchRouter({
      onPost: (url, body) => {
        if (url === "/api/reviews/1/reply") {
          expect(body).toEqual({ reply: "Thanks for the feedback!" });
          return { ok: true };
        }
        return { ok: true };
      },
    });
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Bagus banget!")).toBeInTheDocument());

    const menu = await openRowMenu(user);
    await user.click(within(menu).getByText("Reply"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Reply to Review")).toBeInTheDocument();
    const textarea = within(dialog).getByPlaceholderText("Write a reply…");
    await user.type(textarea, "Thanks for the feedback!");
    await user.click(within(dialog).getByRole("button", { name: /^send reply$/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/reviews/1/reply", expect.objectContaining({ method: "POST" })),
    );
    await waitFor(() => expect(screen.getByText("Reply sent.")).toBeInTheDocument());
  });

  it("Delete Review opens a destructive confirm dialog and, on confirm, calls DELETE /api/reviews/:id", async () => {
    const user = userEvent.setup();
    let deletedUrl: string | null = null;
    const fetchSpy = mockFetchRouter({
      onDelete: (url) => {
        deletedUrl = url;
        return { ok: true };
      },
    });
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Bagus banget!")).toBeInTheDocument());

    const menu = await openRowMenu(user);
    expect(within(menu).getByText("Delete Review").closest('[data-slot="dropdown-menu-item"]'))
      .toHaveAttribute("data-variant", "destructive");
    await user.click(within(menu).getByText("Delete Review"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete this review?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^delete review$/i }));

    await waitFor(() => expect(deletedUrl).toBe("/api/reviews/1"));
    await waitFor(() => expect(screen.getByText("Review deleted.")).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledWith("/api/reviews/1", expect.objectContaining({ method: "DELETE" }));
  });
});
