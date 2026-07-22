import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { EmptyState } from "../components/shared/EmptyState";
import { DataTable } from "../components/shared/DataTable";
import { Pagination } from "../components/shared/Pagination";
import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { toast } from "sonner";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface Review {
  id: number;
  rating: number;
  comment: string | null;
  hidden: boolean;
  createdAtDisplay: string | null;
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
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={i <= n ? "h-4 w-4 fill-amberx text-amberx" : "h-4 w-4 text-ink-faint"}
        />
      ))}
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
      apiPost<void>(`/api/reviews/${id}/hide`, { hidden: hide }),
    onSuccess: (_data, { hide }) => {
      void qc.invalidateQueries({ queryKey: ["reviews"] });
      toast.success(hide ? "Review hidden." : "Review restored.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
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

        {isError ? (
          <p className="text-sm text-rust">Failed to load reviews.</p>
        ) : (
          <DataTable
            columns={[
              { key: "rating", header: "Rating", render: (r) => <Stars n={r.rating} /> },
              {
                key: "reviewer",
                header: "Reviewer",
                render: (r) => (
                  <div className={r.hidden ? "opacity-50" : ""}>
                    <div className="text-ink">{r.user?.fullName ?? "Unknown"}</div>
                    <div className="text-xs text-ink-soft">{r.denomination?.name ?? "—"}</div>
                  </div>
                ),
              },
              {
                key: "comment",
                header: "Comment",
                render: (r) => <span className={`text-sm ${r.hidden ? "text-ink-soft opacity-50" : "text-ink"}`}>{r.comment ?? "—"}</span>,
              },
              {
                key: "date",
                header: "Date",
                render: (r) => <span className="text-xs text-ink-soft">{r.createdAtDisplay ?? "—"}</span>,
              },
              {
                key: "actions",
                header: "",
                render: (r) => (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={toggleHide.isPending}
                    onClick={() => toggleHide.mutate({ id: r.id, hide: !r.hidden })}
                  >
                    {r.hidden ? "Restore" : "Hide"}
                  </Button>
                ),
              },
            ]}
            data={data?.reviews ?? []}
            isLoading={isLoading}
            keyExtractor={(r) => r.id}
            empty={
              <EmptyState
                icon={Star}
                title="No reviews found."
                description="Customer reviews will appear here."
              />
            }
          />
        )}

        {data && (
          <Pagination page={page} pageSize={50} total={data.total} onPageChange={goPage} />
        )}
      </div>
    </PageLayout>
  );
}
