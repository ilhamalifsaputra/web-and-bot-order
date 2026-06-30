import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
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

interface OrderRow {
  id: number;
  orderCode: string;
  status: string;
  currency: string;
  totalAmount: string;
  createdAt: string;
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
  const [draft, setDraft] = useState({ status: "", q: "", since: "", until: "" });
  const [filters, setFilters] = useState<Filters>({ status: "", q: "", since: "", until: "", page: 1 });

  const { data, isLoading, isError } = useOrders(filters);

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
  }

  function clearFilters() {
    setDraft({ status: "", q: "", since: "", until: "" });
    setFilters({ status: "", q: "", since: "", until: "", page: 1 });
  }

  return (
    <PageLayout title="Orders">
      <PageHeader title="Orders" />

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
                  {s}
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
            key: "date",
            header: "Date",
            render: (row) => (
              <span className="text-xs text-ink-soft">
                {new Date(row.createdAt).toLocaleDateString()}
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
          <EmptyState
            icon={ShoppingCart}
            title="No orders found"
            description="Try adjusting your filters."
            action={{ label: "Clear filters", onClick: clearFilters }}
          />
        }
      />

      {data && (
        <div className="flex gap-2 mt-4">
          {data.page > 1 && (
            <Button
              variant="outline"
              onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
            >
              ← Prev
            </Button>
          )}
          {data.hasNext && (
            <Button
              variant="outline"
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
