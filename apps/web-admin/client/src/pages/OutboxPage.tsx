import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

interface OutboxRow {
  id: number;
  event: string;
  orderId: number | null;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

interface OutboxResponse {
  rows: OutboxRow[];
  total: number;
  page: number;
  hasNext: boolean;
  counts: Record<string, number>;
}

function formatTs(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function OutboxPage() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [applied, setApplied] = useState({ status: "", page: 1 });
  const [retrying, setRetrying] = useState<Set<number>>(new Set());

  const { data, isLoading, isError, refetch } = useQuery<OutboxResponse>({
    queryKey: ["outbox", applied],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (applied.status) p.set("status", applied.status);
      if (applied.page > 1) p.set("page", String(applied.page));
      const res = await fetch(`/api/outbox?${p}`, { credentials: "include" });
      if (!res.ok) throw new Error(`/api/outbox ${res.status}`);
      return res.json() as Promise<OutboxResponse>;
    },
  });

  async function retry(id: number) {
    setRetrying((s) => new Set([...s, id]));
    try {
      await apiPost(`/outbox/${id}/retry`, {});
      await refetch();
    } finally {
      setRetrying((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  function apply() {
    setPage(1);
    setApplied({ status, page: 1 });
  }

  function goPage(n: number) {
    setPage(n);
    setApplied((a) => ({ ...a, page: n }));
  }

  return (
    <PageLayout title="Outbox">
      <PageHeader title="Outbox" />

      <div className="flex flex-col gap-4">
        {data?.counts && (
          <div className="flex gap-3">
            {Object.entries(data.counts).map(([k, v]) => (
              <span key={k} className="rounded-full bg-sand px-3 py-1 text-xs font-medium text-ink">
                {k}: {v}
              </span>
            ))}
          </div>
        )}

        <FilterBar onApply={apply}>
          <Select value={status || "_all_"} onValueChange={v => setStatus(v === "_all_" ? "" : v)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All statuses</SelectItem>
              {["PENDING", "SENT", "FAILED"].map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterBar>

        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Failed to load outbox.</p>}

        {data && data.rows.length === 0 && <EmptyState title="No notifications found." />}

        {data && data.rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-ink-soft">
                  <th className="px-4 py-3 font-medium">ID</th>
                  <th className="px-4 py-3 font-medium">Event</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Attempts</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Sent</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-sand/40">
                    <td className="px-4 py-2 font-mono text-xs text-ink-soft">{row.id}</td>
                    <td className="px-4 py-2 text-ink">{row.event}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        row.status === "SENT" ? "bg-pine-tint text-pine" :
                        row.status === "FAILED" ? "bg-rust/10 text-rust" :
                        "bg-sand text-ink"
                      }`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-ink-soft">{row.attempts}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-ink-soft">{formatTs(row.createdAt)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-ink-soft">{formatTs(row.sentAt)}</td>
                    <td className="px-4 py-2">
                      {row.status === "FAILED" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={retrying.has(row.id)}
                          onClick={() => retry(row.id)}
                        >
                          Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
