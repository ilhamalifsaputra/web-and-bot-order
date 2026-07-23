import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatTile } from "../components/shared/StatTile";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Boxes, Eye, Download, MoreVertical } from "lucide-react";
import { SearchBar } from "../components/shared/SearchBar";
import { ProgressBar } from "../components/shared/ProgressBar";
import { StatusBadge } from "../components/shared/StatusBadge";

interface DenominationRow {
  id: number;
  name: string;
  isActive: boolean;
  product: {
    id: number;
    name: string;
    category: { id: number; name: string } | null;
  } | null;
}

interface StockData {
  denominations: DenominationRow[];
  counts: Record<string, { available: number; reserved: number; sold: number; dead: number }>;
  waiting: Record<string, number>;
}

type AvailabilityFilter = "all" | "in-stock" | "low" | "out";
type SortMode = "name" | "available-asc" | "category";

/** The three mutually-exclusive stock tiers a denomination can be in — the
 *  single source of truth for the KPI counts, the Availability filter, and
 *  the Status column, so the `<5`/`===0` thresholds only live in one place. */
function stockTier(available: number): "out" | "low" | "healthy" {
  if (available === 0) return "out";
  if (available < 5) return "low";
  return "healthy";
}

function compareRows(
  a: DenominationRow,
  b: DenominationRow,
  sortBy: SortMode,
  counts: StockData["counts"],
): number {
  if (sortBy === "available-asc") {
    const av = counts[String(a.id)]?.available ?? 0;
    const bv = counts[String(b.id)]?.available ?? 0;
    return av - bv;
  }
  if (sortBy === "category") {
    return (a.product?.category?.name ?? "").localeCompare(b.product?.category?.name ?? "");
  }
  return a.name.localeCompare(b.name);
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
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [availabilityFilter, setAvailabilityFilter] = useState<AvailabilityFilter>("all");
  const [sortBy, setSortBy] = useState<SortMode>("name");

  if (isError) {
    return (
      <PageLayout title="Stock">
        <p className="text-rust">Failed to load stock.</p>
      </PageLayout>
    );
  }

  const denominations = data?.denominations ?? [];
  const counts = data?.counts ?? {};
  const isGenuinelyEmpty = denominations.length === 0;

  const categories = Array.from(
    denominations.reduce((map, d) => {
      if (d.product?.category) map.set(d.product.category.id, d.product.category.name);
      return map;
    }, new Map<number, string>()),
  )
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalSku = denominations.length;
  const availableCount = denominations.filter((d) => (counts[String(d.id)]?.available ?? 0) > 0).length;
  const lowStockCount = denominations.filter((d) => stockTier(counts[String(d.id)]?.available ?? 0) === "low").length;
  const outOfStockCount = denominations.filter((d) => stockTier(counts[String(d.id)]?.available ?? 0) === "out").length;

  const hasActiveFilter =
    !!filter || categoryFilter !== "all" || availabilityFilter !== "all" || sortBy !== "name";
  const clearFilters = () => {
    setFilter("");
    setCategoryFilter("all");
    setAvailabilityFilter("all");
    setSortBy("name");
  };

  const filtered = denominations
    .filter(
      (d) =>
        !filter ||
        d.name.toLowerCase().includes(filter.toLowerCase()) ||
        (d.product?.name ?? "").toLowerCase().includes(filter.toLowerCase()) ||
        (d.product?.category?.name ?? "").toLowerCase().includes(filter.toLowerCase()),
    )
    .filter((d) => categoryFilter === "all" || String(d.product?.category?.id) === categoryFilter)
    .filter((d) => {
      if (availabilityFilter === "all") return true;
      const available = counts[String(d.id)]?.available ?? 0;
      if (availabilityFilter === "in-stock") return available > 0;
      if (availabilityFilter === "low") return stockTier(available) === "low";
      return stockTier(available) === "out";
    })
    .sort((a, b) => compareRows(a, b, sortBy, counts));

  return (
    <PageLayout title="Stock">
      <PageHeader
        title="Stock"
        description="Monitor inventory levels and manage stock across all denominations."
        actions={
          <a href="/api/stock/export">
            <Button variant="outline" size="sm">Export CSV</Button>
          </a>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Total SKU" value={totalSku} />
        <StatTile label="Available" value={availableCount} />
        <StatTile label="Low Stock" value={lowStockCount} />
        <StatTile label="Out of Stock" value={outOfStockCount} />
      </div>

      <FilterBar onClear={hasActiveFilter ? clearFilters : undefined} className="mb-4">
        <SearchBar
          value={filter}
          onChange={setFilter}
          placeholder="Filter by denomination, product, or category…"
        />
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Category</label>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Availability</label>
          <Select value={availabilityFilter} onValueChange={(v) => setAvailabilityFilter(v as AvailabilityFilter)}>
            <SelectTrigger size="sm" className="w-36">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="in-stock">In Stock</SelectItem>
              <SelectItem value="low">Low Stock</SelectItem>
              <SelectItem value="out">Out of Stock</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Sort</label>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortMode)}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name A–Z</SelectItem>
              <SelectItem value="available-asc">Low Stock First</SelectItem>
              <SelectItem value="category">Category</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
            key: "status",
            header: "Status",
            render: (row) => {
              const available = counts[String(row.id)]?.available ?? 0;
              const tier = stockTier(available);
              if (tier === "out") return <StatusBadge status="OUT_OF_STOCK" />;
              if (tier === "low") return <StatusBadge status="LOW_STOCK" />;
              return <StatusBadge status="IN_STOCK" />;
            },
          },
          {
            key: "available",
            header: "Available",
            render: (row) => {
              const available = counts[String(row.id)]?.available ?? 0;
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
              const cnt = counts[String(row.id)];
              const available = cnt?.available ?? 0;
              const reserved = cnt?.reserved ?? 0;
              const sold = cnt?.sold ?? 0;
              const total = available + reserved + sold;
              const pct = total > 0 ? Math.round((available / total) * 100) : 0;
              const tone = pct < 20 ? "rust" : pct < 50 ? "amberx" : "grass";
              return (
                <div className="min-w-[120px]">
                  <div className="mb-1 text-xs text-ink-soft">
                    {total > 0 ? `${available} / ${total} Ready` : "No stock added"}
                  </div>
                  <ProgressBar value={pct} tone={tone} />
                </div>
              );
            },
          },
          {
            key: "reserved",
            header: "Reserved",
            render: (row) => {
              const cnt = counts[String(row.id)];
              return (
                <span className="text-sm text-ink-soft">{cnt?.reserved ?? 0}</span>
              );
            },
          },
          {
            key: "sold",
            header: "Sold",
            render: (row) => {
              const cnt = counts[String(row.id)];
              return (
                <span className="text-sm text-ink-soft">{cnt?.sold ?? 0}</span>
              );
            },
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
            key: "actions",
            header: "",
            render: (row) => {
              const available = counts[String(row.id)]?.available ?? 0;
              return (
                <div onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => navigate(`/stock/${row.id}`)}>
                        <Eye className="h-4 w-4" />
                        View
                      </DropdownMenuItem>
                      {available > 0 && (
                        <DropdownMenuItem asChild>
                          <a href={`/api/stock/${row.id}/download`}>
                            <Download className="h-4 w-4" />
                            Download Credentials
                          </a>
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            },
          },
        ]}
        data={filtered}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => navigate(`/stock/${row.id}`)}
        empty={
          isGenuinelyEmpty ? (
            <EmptyState
              icon={Boxes}
              title="No denominations found"
              description="Stock will appear here once denominations exist."
              action={{ label: "Go to Catalog", onClick: () => navigate("/catalog") }}
            />
          ) : (
            <EmptyState
              icon={Boxes}
              title="No denominations found"
              description="Try adjusting your search or filters."
              secondaryAction={{ label: "Clear Filters", onClick: clearFilters }}
            />
          )
        }
      />
    </PageLayout>
  );
}
