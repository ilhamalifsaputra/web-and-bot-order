import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { EmptyState } from "../components/shared/EmptyState";
import { DataTable } from "../components/shared/DataTable";
import { StatusBadge } from "../components/shared/StatusBadge";
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
      await apiPost(`/api/outbox/${id}/retry`, {});
      await refetch();
    } catch (e: unknown) {
      alert((e instanceof Error ? e.message : String(e)) || "Failed to retry notification");
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

        {data && (
          <DataTable
            columns={[
              { key: "id", header: "ID", render: (row) => <span className="font-mono text-xs text-ink-soft">{row.id}</span> },
              { key: "event", header: "Event", render: (row) => <span className="text-ink">{row.event}</span> },
              { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
              { key: "attempts", header: "Attempts", render: (row) => <span className="text-ink-soft">{row.attempts}</span> },
              { key: "created", header: "Created", render: (row) => <span className="whitespace-nowrap text-ink-soft">{formatTs(row.createdAt)}</span> },
              { key: "sent", header: "Sent", render: (row) => <span className="whitespace-nowrap text-ink-soft">{formatTs(row.sentAt)}</span> },
              {
                key: "actions",
                header: "",
                render: (row) =>
                  row.status === "FAILED" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={retrying.has(row.id)}
                      onClick={() => retry(row.id)}
                    >
                      Retry
                    </Button>
                  ) : null,
              },
            ]}
            data={data.rows}
            keyExtractor={(row) => row.id}
            empty={<EmptyState title="No notifications found." />}
          />
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
