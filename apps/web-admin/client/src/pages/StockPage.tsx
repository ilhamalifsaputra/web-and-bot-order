import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Boxes } from "lucide-react";

interface DenominationRow {
  id: number;
  name: string;
  isActive: boolean;
  product: {
    id: number;
    name: string;
    category: { name: string } | null;
  } | null;
}

interface StockData {
  denominations: DenominationRow[];
  counts: Record<string, { available: number; reserved: number; sold: number; dead: number }>;
  waiting: Record<string, number>;
}

function useStock() {
  return useQuery<StockData>({
    queryKey: ["stock"],
    queryFn: async () => {
      const res = await fetch("/api/stock");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<StockData>;
    },
  });
}

export function StockPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useStock();
  const [filter, setFilter] = useState("");

  if (isError) {
    return (
      <PageLayout title="Stock">
        <p className="text-rust">Failed to load stock.</p>
      </PageLayout>
    );
  }

  const filtered = (data?.denominations ?? []).filter(
    (d) =>
      !filter ||
      d.name.toLowerCase().includes(filter.toLowerCase()) ||
      (d.product?.name ?? "").toLowerCase().includes(filter.toLowerCase()) ||
      (d.product?.category?.name ?? "").toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <PageLayout title="Stock">
      <PageHeader title="Stock" />

      <FilterBar
        onClear={filter ? () => setFilter("") : undefined}
        className="mb-4"
      >
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by denomination, product, or category…"
          className="w-80"
        />
      </FilterBar>

      <DataTable
        columns={[
          {
            key: "denomination",
            header: "Denomination",
            render: (row) => (
              <div>
                <div className="font-medium text-sm text-ink">{row.name}</div>
                <div className="text-xs text-ink-soft">
                  {row.product?.category?.name ?? "—"}
                </div>
              </div>
            ),
          },
          {
            key: "product",
            header: "Product",
            render: (row) => (
              <span className="text-sm text-ink-soft">
                {row.product?.name ?? "—"}
              </span>
            ),
          },
          {
            key: "available",
            header: "Available",
            render: (row) => {
              const cnt = data?.counts[String(row.id)];
              const available = cnt?.available ?? 0;
              return (
                <span
                  className={
                    available === 0
                      ? "font-semibold text-rust"
                      : "text-sm text-ink"
                  }
                >
                  {available}
                </span>
              );
            },
          },
          {
            key: "reserved",
            header: "Reserved",
            render: (row) => {
              const cnt = data?.counts[String(row.id)];
              return (
                <span className="text-sm text-ink-soft">{cnt?.reserved ?? 0}</span>
              );
            },
          },
          {
            key: "sold",
            header: "Sold",
            render: (row) => {
              const cnt = data?.counts[String(row.id)];
              return (
                <span className="text-sm text-ink-soft">{cnt?.sold ?? 0}</span>
              );
            },
          },
          {
            key: "waiting",
            header: "Waiting",
            render: (row) => {
              const wait = data?.waiting[String(row.id)] ?? 0;
              return (
                <span className="text-sm text-ink-soft">
                  {wait > 0 ? wait : "—"}
                </span>
              );
            },
          },
          {
            key: "stock",
            header: "Stock",
            render: (row) => {
              const cnt = data?.counts[String(row.id)];
              const available = cnt?.available ?? 0;
              const reserved = cnt?.reserved ?? 0;
              const sold = cnt?.sold ?? 0;
              const total = available + reserved + sold;
              const pct = total > 0 ? Math.round((available / total) * 100) : 0;
              return (
                <div className="min-w-[120px]">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-ink-soft">{available} ready</span>
                    <span className="text-ink-soft">{pct}%</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-sand overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        pct < 20 ? "bg-rust" : pct < 50 ? "bg-amberx" : "bg-grass"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            },
          },
          {
            key: "status",
            header: "Status",
            render: (row) => {
              const cnt = data?.counts[String(row.id)];
              const available = cnt?.available ?? 0;
              if (available === 0) {
                return <Badge variant="destructive">Out of Stock</Badge>;
              }
              if (available < 5) {
                return <Badge variant="destructive">Low Stock</Badge>;
              }
              return null;
            },
          },
          {
            key: "actions",
            header: "",
            render: (row) => (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/stock/${row.id}`);
                  }}
                >
                  View
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/stock/${row.id}/add`);
                  }}
                >
                  + Stock
                </Button>
              </div>
            ),
          },
        ]}
        data={filtered}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => navigate(`/stock/${row.id}`)}
        empty={
          <EmptyState
            icon={Boxes}
            title="No denominations found"
            description="Try adjusting your filter."
          />
        }
      />
    </PageLayout>
  );
}
