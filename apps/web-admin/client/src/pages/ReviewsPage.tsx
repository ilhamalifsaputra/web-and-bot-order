import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { EmptyState } from "../components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { apiPost } from "../api/client";

interface Review {
  id: number;
  rating: number;
  comment: string | null;
  hidden: boolean;
  createdAt: string;
  user: { username: string | null; fullName: string } | null;
  denomination: { name: string } | null;
}

interface ReviewsResponse {
  reviews: Review[];
  total: number;
  page: number;
  hasNext: boolean;
  summaries: { productName: string; avg: number; count: number }[];
}

function Stars({ n }: { n: number }) {
  return (
    <span className="text-amberx">
      {"★".repeat(n)}{"☆".repeat(5 - n)}
    </span>
  );
}

export function ReviewsPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [applied, setApplied] = useState({ page: 1, hidden: "" });

  const { data, isLoading, isError } = useQuery<ReviewsResponse>({
    queryKey: ["reviews", applied],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (applied.hidden) p.set("hidden", applied.hidden);
      if (applied.page > 1) p.set("page", String(applied.page));
      const res = await fetch(`/api/reviews?${p}`, { credentials: "include" });
      if (!res.ok) throw new Error(`/api/reviews ${res.status}`);
      return res.json() as Promise<ReviewsResponse>;
    },
  });

  const toggleHide = useMutation({
    mutationFn: ({ id, hide }: { id: number; hide: boolean }) =>
      apiPost<void>(`/reviews/${id}/hide`, { hidden: hide ? "1" : "0" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reviews"] }),
  });

  function goPage(n: number) {
    setPage(n);
    setApplied((a) => ({ ...a, page: n }));
  }

  return (
    <PageLayout title="Reviews">
      <PageHeader title="Reviews" />

      <div className="flex flex-col gap-4">
        <FilterBar>
          <Select
            value={applied.hidden || "_all_"}
            onValueChange={v => {
              const hidden = v === "_all_" ? "" : v;
              setPage(1);
              setApplied({ page: 1, hidden });
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              <SelectItem value="0">Visible</SelectItem>
              <SelectItem value="1">Hidden</SelectItem>
            </SelectContent>
          </Select>
        </FilterBar>

        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Failed to load reviews.</p>}

        {data && data.reviews.length === 0 && <EmptyState title="No reviews found." />}

        {data && data.reviews.length > 0 && (
          <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-card">
            {data.reviews.map((r) => (
              <div key={r.id} className={`flex items-start justify-between gap-4 p-4 ${r.hidden ? "opacity-50" : ""}`}>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Stars n={r.rating} />
                    <span className="text-xs text-ink-soft">
                      {r.user?.fullName ?? "Unknown"} · {r.denomination?.name ?? "—"}
                    </span>
                  </div>
                  {r.comment && <p className="text-sm text-ink">{r.comment}</p>}
                  <p className="text-xs text-ink-faint">{new Date(r.createdAt).toLocaleDateString()}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={toggleHide.isPending}
                  onClick={() => toggleHide.mutate({ id: r.id, hide: !r.hidden })}
                  className="shrink-0"
                >
                  {r.hidden ? "Restore" : "Hide"}
                </Button>
              </div>
            ))}
          </div>
        )}

        {data && (data.hasNext || page > 1) && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => goPage(page - 1)}
            >
              ← Prev
            </Button>
            <span className="text-sm text-ink-soft">Page {page}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!data.hasNext}
              onClick={() => goPage(page + 1)}
            >
              Next →
            </Button>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
