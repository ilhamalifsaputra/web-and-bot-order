import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { Pagination } from "../components/shared/Pagination";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { DateInput } from "../components/shared/DateInput";
import { Stars } from "../components/shared/Stars";
import { ReviewsKpiRow } from "./reviews/ReviewsKpiRow";
import { RatingDistributionCard } from "./reviews/RatingDistributionCard";
import { ProductRatingsCard } from "./reviews/ProductRatingsCard";
import { ReplyDialog, type ReplyDialogReview } from "./reviews/ReplyDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Star,
  MoreVertical,
  Eye,
  ShoppingBag,
  Reply,
  MessageSquareOff,
  XCircle,
  RotateCcw,
  EyeOff,
  Trash2,
} from "lucide-react";
import { formatRelativeTime } from "../lib/relativeTime";
import { apiGet, apiPost, apiDelete } from "../api/client";
import { describeError } from "../lib/errorMessages";
import { useDebouncedValue } from "../hooks/useDebouncedValue";

interface ReviewUser {
  fullName: string | null;
  username: string | null;
  loginUsername: string | null;
}

interface ReviewProduct {
  name: string;
}

interface ReviewRow {
  id: number;
  userId: number;
  orderId: number;
  productId: number;
  rating: number;
  comment: string | null;
  hidden: boolean;
  createdAt: string;
  createdAtDisplay: string | null;
  /** Reply-workflow state, orthogonal to `hidden` — PENDING_REPLY | REPLIED | CLOSED. */
  status: string;
  sentiment: string;
  adminReply: string | null;
  repliedAt: string | null;
  user: ReviewUser | null;
  product: ReviewProduct | null;
}

interface ReviewSummary {
  productId: number;
  productName: string;
  count: number;
  hiddenCount: number;
  avg: number | null;
}

interface ReviewsResponse {
  reviews: ReviewRow[];
  total: number;
  page: number;
  hasNext: boolean;
  summaries: ReviewSummary[];
}

interface Filters {
  q: string;
  rating: string; // "" | "1".."5"
  status: string; // "" | PENDING_REPLY | REPLIED | CLOSED
  sentiment: string; // "" | POSITIVE | NEUTRAL | NEGATIVE
  product: string; // "" | productId
  hidden: string; // "" | "0" | "1"
  since: string;
  until: string;
  page: number;
}

const PAGE_SIZE = 50;

const EMPTY_DRAFT = {
  rating: "",
  status: "",
  sentiment: "",
  product: "",
  hidden: "",
  since: "",
  until: "",
};

const EMPTY_FILTERS: Filters = { q: "", page: 1, ...EMPTY_DRAFT };

const RATING_VALUES = ["5", "4", "3", "2", "1"];
const STATUS_VALUES = ["PENDING_REPLY", "REPLIED", "CLOSED"];
const SENTIMENT_VALUES = ["POSITIVE", "NEUTRAL", "NEGATIVE"];

function statusLabel(status: string): string {
  return status
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function sentimentLabel(sentiment: string): string {
  return sentiment.charAt(0) + sentiment.slice(1).toLowerCase();
}

/** Primary reviewer identity line — real name, else the Telegram handle, else
 *  the storefront login handle, never a bare "—". */
function primaryIdentity(user: ReviewUser | null): string {
  if (!user) return "Unknown Customer";
  if (user.fullName) return user.fullName;
  if (user.username) return `@${user.username}`;
  if (user.loginUsername) return user.loginUsername;
  return "Unknown Customer";
}

/** Secondary line — only shown when it adds information beyond the primary
 *  line (i.e. the username wasn't already promoted into it above). */
function secondaryIdentity(user: ReviewUser | null): string {
  return user?.fullName && user.username ? `@${user.username}` : "";
}

function reviewerInitial(user: ReviewUser | null): string {
  const source = user?.fullName ?? user?.username ?? user?.loginUsername;
  return source && source.length > 0 ? source[0]!.toUpperCase() : "?";
}

function useReviews(filters: Filters) {
  return useQuery<ReviewsResponse>({
    queryKey: ["reviews", filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.q) params.set("q", filters.q);
      if (filters.rating) params.set("rating", filters.rating);
      if (filters.status) params.set("status", filters.status);
      if (filters.sentiment) params.set("sentiment", filters.sentiment);
      if (filters.product) params.set("product", filters.product);
      if (filters.hidden) params.set("hidden", filters.hidden);
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      if (filters.page > 1) params.set("page", String(filters.page));
      return apiGet<ReviewsResponse>(`/api/reviews?${params.toString()}`);
    },
  });
}

export function ReviewsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  // Search is live/debounced rather than Apply-gated (mirrors UsersPage.tsx)
  // — its own immediate-typing state, separate from `draft`.
  const [searchInput, setSearchInput] = useState("");
  const debouncedQ = useDebouncedValue(searchInput, 300);

  useEffect(() => {
    setFilters((f) => (f.q === debouncedQ ? f : { ...f, q: debouncedQ, page: 1 }));
  }, [debouncedQ]);

  const { data, isLoading, isFetching, isError, refetch } = useReviews(filters);

  const [replyReview, setReplyReview] = useState<ReplyDialogReview | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);

  function invalidateAll() {
    void qc.invalidateQueries({ queryKey: ["reviews"] });
  }

  const toggleHide = useMutation({
    mutationFn: ({ id, hide }: { id: number; hide: boolean }) =>
      apiPost<{ ok: boolean; hidden: boolean }>(`/api/reviews/${id}/hide`, { hidden: hide }),
    onSuccess: (_data, { hide }) => {
      invalidateAll();
      toast.success(hide ? "Review hidden." : "Review restored.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      apiPost<{ ok: boolean }>(`/api/reviews/${id}/status`, { status }),
    onSuccess: (_data, { status }) => {
      invalidateAll();
      toast.success(status === "CLOSED" ? "Review marked closed." : "Review reopened.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const deleteReply = useMutation({
    mutationFn: (id: number) => apiDelete<{ ok: boolean }>(`/api/reviews/${id}/reply`),
    onSuccess: () => {
      invalidateAll();
      toast.success("Reply deleted.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const deleteReviewMutation = useMutation({
    mutationFn: (id: number) => apiDelete<{ ok: boolean }>(`/api/reviews/${id}`),
    onSuccess: () => {
      invalidateAll();
      toast.success("Review deleted.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  function applyFilters() {
    setFilters((f) => ({ ...f, ...draft, page: 1 }));
  }

  function clearFilters() {
    setDraft(EMPTY_DRAFT);
    setSearchInput("");
    setFilters(EMPTY_FILTERS);
  }

  /** KPI cards double as quick filters — clicking one both seeds the draft
   *  (so the FilterBar's controls reflect what's active if the admin opens
   *  it) and commits immediately, rather than requiring a second "Apply". */
  function quickFilter(patch: Partial<typeof EMPTY_DRAFT>) {
    setDraft((d) => ({ ...d, ...patch }));
    setFilters((f) => ({ ...f, ...patch, page: 1 }));
  }

  const hasActiveFilter = Boolean(
    filters.q ||
      filters.rating ||
      filters.status ||
      filters.sentiment ||
      filters.product ||
      filters.hidden ||
      filters.since ||
      filters.until,
  );

  const reviews = data?.reviews ?? [];
  const summaries = data?.summaries ?? [];
  const productOptions = [...summaries].sort((a, b) => a.productName.localeCompare(b.productName));

  const deleteTarget = reviews.find((r) => r.id === deleteTargetId) ?? null;

  function openReply(row: ReviewRow) {
    setReplyReview({ id: row.id, rating: row.rating, comment: row.comment, adminReply: row.adminReply });
    setReplyOpen(true);
  }

  if (isError) {
    return (
      <PageLayout title="Reviews">
        <p className="text-rust">Failed to load reviews.</p>
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Reviews">
      <PageHeader
        title="Reviews"
        description="Moderate customer reviews, track sentiment and reply to feedback."
      />

      <ReviewsKpiRow
        onPendingReplyClick={() => quickFilter({ status: "PENDING_REPLY" })}
        onNegativeClick={() => quickFilter({ sentiment: "NEGATIVE" })}
        onHiddenClick={() => quickFilter({ hidden: "1" })}
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <RatingDistributionCard />
        <div className="lg:col-span-2">
          <ProductRatingsCard summaries={summaries} isLoading={isLoading} />
        </div>
      </div>

      <FilterBar onApply={applyFilters} onClear={clearFilters} className="mb-4">
        <SearchBar
          value={searchInput}
          onChange={setSearchInput}
          loading={isFetching && searchInput !== ""}
          placeholder="Search comment or customer…"
          className="w-full sm:w-64"
        />

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Rating</label>
          <Select
            value={draft.rating || "_all_"}
            onValueChange={(v) => setDraft((d) => ({ ...d, rating: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-28" aria-label="Rating">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {RATING_VALUES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}★
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Reply Status</label>
          <Select
            value={draft.status || "_all_"}
            onValueChange={(v) => setDraft((d) => ({ ...d, status: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-36" aria-label="Reply Status">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {STATUS_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Sentiment</label>
          <Select
            value={draft.sentiment || "_all_"}
            onValueChange={(v) => setDraft((d) => ({ ...d, sentiment: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-32" aria-label="Sentiment">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {SENTIMENT_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {sentimentLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Product</label>
          <Select
            value={draft.product || "_all_"}
            onValueChange={(v) => setDraft((d) => ({ ...d, product: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-44" aria-label="Product">
              <SelectValue placeholder="All products" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {productOptions.map((p) => (
                <SelectItem key={p.productId} value={String(p.productId)}>
                  {p.productName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Visibility</label>
          <Select
            value={draft.hidden || "_all_"}
            onValueChange={(v) => setDraft((d) => ({ ...d, hidden: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-32" aria-label="Visibility">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              <SelectItem value="0">Visible</SelectItem>
              <SelectItem value="1">Hidden</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">From</label>
          <DateInput
            value={draft.since}
            onChange={(e) => setDraft((d) => ({ ...d, since: e.target.value }))}
            className="w-36"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">To</label>
          <DateInput
            value={draft.until}
            onChange={(e) => setDraft((d) => ({ ...d, until: e.target.value }))}
            className="w-36"
          />
        </div>
      </FilterBar>

      <DataTable
        stickyHeader
        columns={[
          {
            key: "customer",
            header: "Customer",
            render: (row) => (
              <div className="flex items-center gap-3">
                <Avatar>
                  <AvatarFallback>{reviewerInitial(row.user)}</AvatarFallback>
                </Avatar>
                <div>
                  <div className="text-sm font-medium text-ink">{primaryIdentity(row.user)}</div>
                  {secondaryIdentity(row.user) && (
                    <div className="text-xs text-ink-soft">{secondaryIdentity(row.user)}</div>
                  )}
                  <Badge variant="secondary" className="mt-1">
                    Verified Purchase
                  </Badge>
                </div>
              </div>
            ),
          },
          {
            key: "review",
            header: "Review",
            render: (row) => (
              <div className={row.hidden ? "flex max-w-xs flex-col gap-1 opacity-50" : "flex max-w-xs flex-col gap-1"}>
                <Stars rating={row.rating} />
                <span className="line-clamp-2 text-sm text-ink-soft">{row.comment ?? "—"}</span>
              </div>
            ),
          },
          {
            key: "product",
            header: "Product",
            render: (row) => <span className="text-sm text-ink-soft">{row.product?.name ?? "—"}</span>,
          },
          {
            key: "status",
            header: "Status",
            render: (row) => (
              <div className="flex flex-wrap items-center gap-1">
                <StatusBadge status={row.hidden ? "HIDDEN" : row.status} />
                <StatusBadge status={row.sentiment} />
              </div>
            ),
          },
          {
            key: "activity",
            header: "Activity",
            render: (row) => (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-ink-soft">{row.createdAtDisplay ?? "—"}</span>
                {row.adminReply != null && row.repliedAt != null && (
                  // No repliedAtDisplay from the API (only createdAtDisplay
                  // is server-formatted) — pass the raw ISO string as the
                  // >30-day fallback too. formatRelativeTime's <30-day path
                  // (the common case for a recently-replied review) is
                  // purely elapsed-time-based and timezone-safe regardless.
                  <span className="text-xs text-ink-faint">
                    Replied {formatRelativeTime(row.repliedAt, row.repliedAt)}
                  </span>
                )}
              </div>
            ),
          },
          {
            key: "actions",
            header: "",
            render: (row) => (
              <div onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for review #${row.id}`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => navigate(`/users/${row.userId}`)}>
                      <Eye className="h-4 w-4" />
                      View Customer
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => navigate(`/orders/${row.orderId}`)}>
                      <ShoppingBag className="h-4 w-4" />
                      View Order
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        openReply(row);
                      }}
                    >
                      <Reply className="h-4 w-4" />
                      {row.adminReply != null ? "Edit Reply" : "Reply"}
                    </DropdownMenuItem>
                    {row.adminReply != null && (
                      <DropdownMenuItem onSelect={() => deleteReply.mutate(row.id)}>
                        <MessageSquareOff className="h-4 w-4" />
                        Delete Reply
                      </DropdownMenuItem>
                    )}
                    {row.status === "CLOSED" ? (
                      <DropdownMenuItem onSelect={() => setStatus.mutate({ id: row.id, status: "PENDING_REPLY" })}>
                        <RotateCcw className="h-4 w-4" />
                        Reopen
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => setStatus.mutate({ id: row.id, status: "CLOSED" })}>
                        <XCircle className="h-4 w-4" />
                        Mark Closed
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => toggleHide.mutate({ id: row.id, hide: !row.hidden })}>
                      {row.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                      {row.hidden ? "Unhide" : "Hide"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={(e) => {
                        e.preventDefault();
                        setDeleteTargetId(row.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete Review
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ),
          },
        ]}
        data={reviews}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        empty={
          hasActiveFilter ? (
            <EmptyState
              icon={Star}
              title="No reviews match these filters."
              description="Try widening the date range or clearing a filter."
              action={{ label: "Refresh", onClick: () => void refetch() }}
              secondaryAction={{ label: "Clear Filters", onClick: clearFilters }}
            />
          ) : (
            <EmptyState
              icon={Star}
              title="No reviews yet"
              description="Customer reviews will appear here after their first delivered order."
              action={{ label: "Refresh", onClick: () => void refetch() }}
            />
          )
        }
      />

      {data && (
        <div className="mt-4">
          <Pagination
            page={filters.page}
            pageSize={PAGE_SIZE}
            total={data.total}
            onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
          />
        </div>
      )}

      <ReplyDialog open={replyOpen} onOpenChange={setReplyOpen} review={replyReview} />

      {deleteTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTargetId(null);
          }}
          title="Delete this review?"
          description="This permanently removes the review and any admin reply. This cannot be undone."
          confirmLabel="Delete Review"
          variant="destructive"
          onConfirm={() => deleteReviewMutation.mutate(deleteTarget.id)}
        />
      )}
    </PageLayout>
  );
}
