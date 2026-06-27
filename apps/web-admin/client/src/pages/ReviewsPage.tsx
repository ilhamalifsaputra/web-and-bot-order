import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { EmptyState } from "../components/shared/EmptyState";
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
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <select
            className="rounded border border-line bg-card px-3 py-1.5 text-sm text-ink"
            value={applied.hidden}
            onChange={(e) => {
              setPage(1);
              setApplied({ page: 1, hidden: e.target.value });
            }}
          >
            <option value="">All</option>
            <option value="0">Visible</option>
            <option value="1">Hidden</option>
          </select>
        </div>

        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Failed to load reviews.</p>}

        {data && data.reviews.length === 0 && <EmptyState message="No reviews found." />}

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
                <button
                  disabled={toggleHide.isPending}
                  onClick={() => toggleHide.mutate({ id: r.id, hide: !r.hidden })}
                  className="shrink-0 rounded border border-line px-2 py-1 text-xs text-ink hover:bg-sand disabled:opacity-40"
                >
                  {r.hidden ? "Restore" : "Hide"}
                </button>
              </div>
            ))}
          </div>
        )}

        {data && (data.hasNext || page > 1) && (
          <div className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => goPage(page - 1)}
              className="rounded border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40">
              ← Prev
            </button>
            <span className="text-sm text-ink-soft">Page {page}</span>
            <button disabled={!data.hasNext} onClick={() => goPage(page + 1)}
              className="rounded border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40">
              Next →
            </button>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
