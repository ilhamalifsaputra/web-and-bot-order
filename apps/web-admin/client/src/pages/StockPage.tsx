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
import { Card, CardContent } from "@/components/ui/card";
import { SearchBar } from "../components/shared/SearchBar";
import { StatusBadge } from "../components/shared/StatusBadge";
import { RestockRequestsHeader } from "../components/shared/RestockRequestsHeader";
import { apiGet } from "../api/client";
import { formatRestockRequests } from "../lib/restockRequests";

interface DenominationRow {
  id: number;
  name: string;
  isActive: boolean;
  /** "auto" = fulfilled from stock rows; anything else (manual/form) never
   *  holds stock, so it must never be scored against the stock tiers below. */
  deliveryType: string;
  product: {
    id: number;
    name: string;
    category: { id: number; name: string } | null;
  } | null;
}

interface StockCounts {
  available: number;
  reserved: number;
  sold: number;
  dead: number;
}

interface StockData {
  denominations: DenominationRow[];
  counts: Record<string, StockCounts>;
  waiting: Record<string, number>;
  /** config.LOW_STOCK_THRESHOLD — the single shared source for "low stock"
   *  across this page, the sidebar badge, and the dashboard's Critical Stock
   *  card (see apps/web-admin/src/routes/api/stock.ts). */
  lowStockThreshold: number;
}

type AvailabilityFilter = "all" | "in-stock" | "low" | "out";
type SortMode = "name" | "available-asc" | "category";

/** The mutually-exclusive states a denomination row can be in — the single
 *  source of truth for the KPI counts, the Availability filter, and the
 *  Status column, so the shared threshold and the manual/inactive carve-outs
 *  only live in one place.
 *
 *  "manual"/"inactive" are deliberately never "out": a manual-delivery SKU
 *  never holds stock rows (it's hand-fulfilled), so scoring it against the
 *  stock tiers would always read "Out of Stock" for a SKU that was never
 *  meant to carry stock at all. An inactive SKU is excluded from the KPI
 *  tiles entirely regardless of delivery type. */
function stockTier(row: DenominationRow, available: number, threshold: number): "inactive" | "manual" | "out" | "low" | "healthy" {
  if (!row.isActive) return "inactive";
  if (row.deliveryType !== "auto") return "manual";
  if (available === 0) return "out";
  if (available <= threshold) return "low";
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
    queryFn: () => apiGet<StockData>("/api/stock"),
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

  const lowStockThreshold = data?.lowStockThreshold ?? 0;
  const tierOf = (d: DenominationRow) => stockTier(d, counts[String(d.id)]?.available ?? 0, lowStockThreshold);

  // Inactive SKUs are excluded from every tile below (they're not part of the
  // live catalog); manual-delivery SKUs count toward Total SKU but never
  // toward the stock-tier tiles (Available/Low/Out) — they never hold stock
  // rows, so scoring them against those tiers would always read "out".
  const activeDenominations = denominations.filter((d) => d.isActive);
  const stockTrackedDenominations = activeDenominations.filter((d) => d.deliveryType === "auto");
  const totalSku = activeDenominations.length;
  const availableCount = stockTrackedDenominations.filter((d) => tierOf(d) === "healthy" || tierOf(d) === "low").length;
  const lowStockCount = stockTrackedDenominations.filter((d) => tierOf(d) === "low").length;
  const outOfStockCount = stockTrackedDenominations.filter((d) => tierOf(d) === "out").length;

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
      const tier = tierOf(d);
      if (availabilityFilter === "in-stock") return tier === "healthy" || tier === "low";
      if (availabilityFilter === "low") return tier === "low";
      return tier === "out";
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
        <StatTile label="Total SKU" value={totalSku} isLoading={!data} />
        <StatTile label="In stock (SKUs)" value={availableCount} isLoading={!data} />
        <StatTile label="Low Stock" value={lowStockCount} isLoading={!data} />
        <StatTile label="Out of Stock" value={outOfStockCount} isLoading={!data} />
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

      <Card>
        <CardContent>
          <DataTable
            nested
            columns={[
              {
                key: "denomination",
                header: "Denomination",
                render: (row) => (
                  <div className="max-w-[240px]">
                    <div className="truncate font-medium text-sm text-ink" title={row.name}>
                      {row.name}
                    </div>
                    <div
                      className="truncate text-xs text-ink-soft"
                      title={row.product?.category?.name ?? undefined}
                    >
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
                  const tier = stockTier(row, available, lowStockThreshold);
                  if (tier === "inactive") return <StatusBadge status="INACTIVE" />;
                  if (tier === "manual") return <StatusBadge status="MANUAL" />;
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
                header: <RestockRequestsHeader />,
                render: (row) => (
                  <span className="text-sm text-ink-soft">
                    {formatRestockRequests(data?.waiting[String(row.id)], counts[String(row.id)]?.available)}
                  </span>
                ),
              },
              {
                key: "stock",
                header: "Stock",
                render: (row) => {
                  const cnt = counts[String(row.id)];
                  const available = cnt?.available ?? 0;
                  const reserved = cnt?.reserved ?? 0;
                  const sold = cnt?.sold ?? 0;
                  const dead = cnt?.dead ?? 0;
                  // "No stock added" only when this SKU has NEVER held a
                  // stock row at all (never an add, sale, reservation, or
                  // dead mark) — distinct from "Sold out", which means it
                  // once had stock but every unit is now spoken for.
                  const everHadStock = available + reserved + sold + dead > 0;
                  const toneClass = !everHadStock
                    ? "text-ink-soft"
                    : available === 0
                      ? "font-semibold text-rust"
                      : available <= lowStockThreshold
                        ? "font-semibold text-amberx"
                        : "font-semibold text-grass";
                  const label = !everHadStock ? "No stock added" : available === 0 ? "Sold out" : `${available} ready`;
                  return (
                    <div className="min-w-[120px] text-sm">
                      <span className={toneClass}>{label}</span>
                      {reserved > 0 && <span className="text-ink-soft"> · {reserved} reserved</span>}
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
                  <span
                    className="block max-w-[240px] truncate text-sm text-ink-soft"
                    title={row.product?.name ?? undefined}
                  >
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
        </CardContent>
      </Card>
    </PageLayout>
  );
}
