import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DateInput } from "../components/shared/DateInput";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { ShoppingCart } from "lucide-react";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { useOperations } from "../hooks/useOperations";
import { orderStatusLabel } from "../lib/orderStatus";

interface OrderRow {
  id: number;
  orderCode: string;
  status: string;
  currency: string;
  totalAmount: string;
  paymentMethod: string;
  createdAt: string;
  createdAtDisplay: string | null;
  user: { id: number; fullName: string | null; username: string | null } | null;
}

interface OrdersData {
  orders: OrderRow[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  statuses: string[];
}

interface Filters {
  status: string;
  q: string;
  since: string;
  until: string;
  page: number;
}

function useOrders(filters: Filters) {
  return useQuery<OrdersData>({
    queryKey: ["orders", filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.q) params.set("q", filters.q);
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      if (filters.page > 1) params.set("page", String(filters.page));
      const res = await fetch(`/api/orders?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<OrdersData>;
    },
  });
}

export function OrdersPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialStatus = searchParams.get("status") ?? "";
  const [draft, setDraft] = useState({ status: initialStatus, q: "", since: "", until: "" });
  const [filters, setFilters] = useState<Filters>({ status: initialStatus, q: "", since: "", until: "", page: 1 });

  const { data, isLoading, isError } = useOrders(filters);
  const { data: operations } = useOperations();
  const awaitingFulfillmentCount = operations?.awaitingFulfillment ?? 0;
  const awaitingFulfillmentActive = filters.status === "PROCESSING";

  if (isError) {
    return (
      <PageLayout title="Orders">
        <p className="text-rust">Failed to load orders.</p>
      </PageLayout>
    );
  }

  const statuses = data?.statuses ?? [];

  function applyFilters() {
    setFilters({ ...draft, page: 1 });
    setSearchParams(draft.status ? { status: draft.status } : {});
  }

  function clearFilters() {
    setDraft({ status: "", q: "", since: "", until: "" });
    setFilters({ status: "", q: "", since: "", until: "", page: 1 });
    setSearchParams({});
  }

  // Quick-filter chip: replaces the old "Awaiting Fulfillment" sidebar nav
  // item (F-001) — toggles the PROCESSING status filter in place, still
  // deep-linkable via ?status=PROCESSING (same URL the Dashboard's Operation
  // Center "Awaiting Fulfillment" card links to).
  function toggleAwaitingFulfillment() {
    const nextStatus = awaitingFulfillmentActive ? "" : "PROCESSING";
    const nextDraft = { ...draft, status: nextStatus };
    setDraft(nextDraft);
    setFilters({ ...nextDraft, page: 1 });
    setSearchParams(nextStatus ? { status: nextStatus } : {});
  }

  // F-016: "No orders yet" only makes sense with zero filters active — once a
  // status/search/date-range filter is narrowing the view, the generic "no
  // orders" copy is misleading (there IS data, just not matching the filter).
  const hasActiveFilter = Boolean(filters.status || filters.q || filters.since || filters.until);

  const exportParams = new URLSearchParams();
  if (filters.status) exportParams.set("status", filters.status);
  if (filters.q) exportParams.set("q", filters.q);
  if (filters.since) exportParams.set("since", filters.since);
  if (filters.until) exportParams.set("until", filters.until);

  return (
    <PageLayout title="Orders">
      <PageHeader
        title="Orders"
        actions={
          <a href={`/api/orders/export?${exportParams.toString()}`}>
            <Button variant="outline" size="sm">Export CSV</Button>
          </a>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={awaitingFulfillmentActive ? "secondary" : "outline"}
          size="sm"
          aria-pressed={awaitingFulfillmentActive}
          onClick={toggleAwaitingFulfillment}
        >
          Awaiting Fulfillment
          {awaitingFulfillmentCount > 0 && (
            <Badge variant={awaitingFulfillmentActive ? "default" : "secondary"}>
              {awaitingFulfillmentCount}
            </Badge>
          )}
        </Button>
      </div>

      <FilterBar onApply={applyFilters} onClear={clearFilters} className="mb-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Status</label>
          <Select
            value={draft.status || "_all_"}
            onValueChange={(v) =>
              setDraft((f) => ({ ...f, status: v === "_all_" ? "" : v }))
            }
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {statuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {orderStatusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Search</label>
          <Input
            placeholder="Order code…"
            value={draft.q}
            onChange={(e) => setDraft((f) => ({ ...f, q: e.target.value }))}
            className="w-48"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">From</label>
          <DateInput
            value={draft.since}
            onChange={(e) => setDraft((f) => ({ ...f, since: e.target.value }))}
            className="w-36"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">To</label>
          <DateInput
            value={draft.until}
            onChange={(e) => setDraft((f) => ({ ...f, until: e.target.value }))}
            className="w-36"
          />
        </div>
      </FilterBar>

      {data && (
        <p className="mb-2 text-xs text-ink-soft">
          {data.total} order{data.total !== 1 ? "s" : ""} total — page {data.page}
        </p>
      )}

      <DataTable
        columns={[
          {
            key: "code",
            header: "Code",
            render: (row) => (
              <span className="font-mono text-sm">{row.orderCode}</span>
            ),
          },
          {
            key: "customer",
            header: "Customer",
            render: (row) => (
              <span className="text-sm">
                {row.user?.fullName ?? row.user?.username ?? "—"}
              </span>
            ),
          },
          {
            key: "status",
            header: "Status",
            render: (row) => <StatusBadge status={row.status} />,
          },
          {
            key: "total",
            header: "Total",
            render: (row) => (
              <span className="font-mono text-sm">
                {formatCurrencyDisplay(row.totalAmount, row.currency as "IDR" | "USDT" | "USD")}
              </span>
            ),
          },
          {
            key: "paymentMethod",
            header: "Payment Method",
            render: (row) => (
              <span className="text-xs text-ink-soft">{row.paymentMethod}</span>
            ),
          },
          {
            key: "date",
            header: "Date",
            render: (row) => (
              <span className="text-xs text-ink-soft">
                {row.createdAtDisplay ?? "—"}
              </span>
            ),
          },
          {
            key: "actions",
            header: "",
            render: (row) => (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/orders/${row.id}`);
                }}
              >
                View
              </Button>
            ),
          },
        ]}
        data={data?.orders ?? []}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => navigate(`/orders/${row.id}`)}
        empty={
          hasActiveFilter ? (
            <EmptyState
              icon={ShoppingCart}
              title="No orders found"
              description="Try adjusting your filters."
              action={{ label: "Clear filters", onClick: clearFilters }}
            />
          ) : (
            <EmptyState
              icon={ShoppingCart}
              title="No orders yet"
              description="Orders placed by customers will show up here."
            />
          )
        }
      />

      {data && (
        <div className="flex gap-2 mt-4">
          {data.page > 1 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
            >
              ← Prev
            </Button>
          )}
          {data.hasNext && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
            >
              Next →
            </Button>
          )}
        </div>
      )}
    </PageLayout>
  );
}
