import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { EmptyState } from "../components/shared/EmptyState";
import { DataTable } from "../components/shared/DataTable";
import { StatusBadge } from "../components/shared/StatusBadge";
import { Send, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
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

/** All 11 NotificationEvent values from packages/core/src/enums.ts. Mirrors
 * AuditPage.tsx's ACTION_LABELS pattern: unknown/future values fall back to
 * humanizeEventCode() instead of showing the raw enum. */
const EVENT_LABELS: Record<string, string> = {
  ORDER_DELIVERED: "Order delivered",
  ADMIN_OVERPAID: "Admin overpaid alert",
  ADMIN_PW_RESET: "Admin password reset",
  ORDER_DELIVERED_DM: "Order delivered (DM)",
  ORDER_PROCESSING_DM: "Order processing (DM)",
  ORDER_MANUAL_DELIVERED_DM: "Manual order delivered (DM)",
  ORDER_PIPELINE_FAILED: "Order pipeline failed",
  PRODUCT_RESTOCKED_BROADCAST: "Product restocked broadcast",
  FLASH_SALE_BROADCAST: "Flash sale broadcast",
  ADMIN_MANUAL_ORDER_QUEUED: "Manual order queued",
  BULK_PURCHASE_BROADCAST: "Bulk purchase broadcast",
};

function humanizeEventCode(event: string): string {
  return event
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? humanizeEventCode(event);
}

interface OutboxRow {
  id: number;
  event: string;
  orderId: number | null;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  createdAtDisplay: string | null;
  sentAt: string | null;
  sentAtDisplay: string | null;
}

interface OutboxResponse {
  rows: OutboxRow[];
  total: number;
  page: number;
  hasNext: boolean;
  counts: Record<string, number>;
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
      toast.success("Notification retried.");
    } catch (e: unknown) {
      toast.error(describeError((e instanceof Error ? e.message : String(e)) || "Failed to retry notification"));
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
              { key: "event", header: "Event", render: (row) => <span className="text-ink" title={row.event}>{eventLabel(row.event)}</span> },
              { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
              { key: "attempts", header: "Attempts", render: (row) => <span className="text-ink-soft">{row.attempts}</span> },
              { key: "created", header: "Created", render: (row) => <span className="whitespace-nowrap text-ink-soft">{row.createdAtDisplay ?? "—"}</span> },
              { key: "sent", header: "Sent", render: (row) => <span className="whitespace-nowrap text-ink-soft">{row.sentAtDisplay ?? "—"}</span> },
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
                      <RefreshCw className="h-4 w-4" />
                      Retry
                    </Button>
                  ) : null,
              },
            ]}
            data={data.rows}
            keyExtractor={(row) => row.id}
            empty={
              <EmptyState
                icon={Send}
                title="No notifications found."
                description="Outbound notifications will appear here."
              />
            }
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
              <ChevronLeft className="h-4 w-4" />
              Prev
            </Button>
            <span className="text-sm text-ink-soft">Page {page}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!data.hasNext}
              onClick={() => goPage(page + 1)}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
