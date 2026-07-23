import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { StatusBadge } from "../components/shared/StatusBadge";
import { StatTile } from "../components/shared/StatTile";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Zap, Plus } from "lucide-react";
import { apiGet, apiPost } from "../api/client";

type FlashStatus = "live" | "scheduled" | "ended";

interface FlashInfo {
  discountPercent: string;
  windowDisplay: string;
  status: FlashStatus;
}

interface DenominationRow {
  id: number;
  name: string;
  price: string;
  isActive: boolean;
  productName: string;
  categoryName: string | null;
  flash: FlashInfo | null;
}

type StatusFilter = "all" | FlashStatus | "inactive";
type SortMode = "name" | "discount" | "product";

const STATUS_BADGE: Record<StatusFilter, string> = {
  all: "",
  scheduled: "SCHEDULED",
  live: "RUNNING",
  ended: "EXPIRED",
  inactive: "INACTIVE",
};

function useFlashSaleDenominations() {
  return useQuery<{ denominations: DenominationRow[] }>({
    queryKey: ["flash-sales", "denominations"],
    queryFn: () => apiGet("/api/flash-sales/denominations"),
  });
}

/** Display-only derivation of the already-final server price + discount —
 *  mirrors formatCurrencyDisplay's own Number()-based formatting, not a new
 *  money computation and nothing here is ever persisted. */
function flashPriceOf(row: DenominationRow): string {
  const price = Number(row.price);
  const percent = Number(row.flash!.discountPercent);
  return ((price * (100 - percent)) / 100).toFixed(0);
}

export function FlashSalesPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useFlashSaleDenominations();
  const [filter, setFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortMode>("name");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [discountPercent, setDiscountPercent] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const rows = useMemo(() => data?.denominations ?? [], [data]);

  const hasActiveFilter = filter !== "" || categoryFilter !== "all" || statusFilter !== "all";

  function clearFilters() {
    setFilter("");
    setCategoryFilter("all");
    setStatusFilter("all");
  }

  // A stale selection surviving a new filter result set would let a bulk
  // action silently apply to rows no longer on screen — clear it whenever
  // the visible result set can change.
  useEffect(() => {
    setSelected(new Set());
  }, [filter, categoryFilter, statusFilter, sortBy]);

  function toggleSelected(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const categories = useMemo(
    () => Array.from(new Set(rows.map((d) => d.categoryName).filter((c): c is string => c !== null))).sort(),
    [rows],
  );

  const filtered = rows
    .filter(
      (d) =>
        !filter ||
        d.name.toLowerCase().includes(filter.toLowerCase()) ||
        d.productName.toLowerCase().includes(filter.toLowerCase()) ||
        (d.categoryName ?? "").toLowerCase().includes(filter.toLowerCase()),
    )
    .filter((d) => categoryFilter === "all" || d.categoryName === categoryFilter)
    .filter((d) => {
      if (statusFilter === "all") return true;
      if (statusFilter === "inactive") return d.flash === null;
      return d.flash?.status === statusFilter;
    })
    .sort((a, b) => {
      if (sortBy === "discount") {
        const da = a.flash ? Number(a.flash.discountPercent) : -1;
        const db = b.flash ? Number(b.flash.discountPercent) : -1;
        return db - da;
      }
      if (sortBy === "product") return a.productName.localeCompare(b.productName);
      return a.name.localeCompare(b.name);
    });

  const scheduledCount = rows.filter((d) => d.flash?.status === "scheduled").length;
  const runningCount = rows.filter((d) => d.flash?.status === "live").length;
  const expiredCount = rows.filter((d) => d.flash?.status === "ended").length;
  const discountedCount = rows.filter((d) => d.flash !== null).length;

  const allFilteredSelected = filtered.length > 0 && filtered.every((d) => selected.has(d.id));
  function toggleSelectAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filtered.forEach((d) => next.delete(d.id));
      } else {
        filtered.forEach((d) => next.add(d.id));
      }
      return next;
    });
  }

  const percentNumber = Number(discountPercent.trim());
  const percentIsValid =
    discountPercent.trim() !== "" && !Number.isNaN(percentNumber) && percentNumber > 0 && percentNumber <= 100;
  const canSubmit = percentIsValid && startsAt.trim() !== "" && endsAt.trim() !== "";
  const alreadyScheduledCount = Array.from(selected).filter((id) => rows.find((r) => r.id === id)?.flash).length;

  function openNewFlashSale() {
    if (selected.size === 0) {
      toast("Select one or more SKUs below first.");
      return;
    }
    setDialogOpen(true);
  }

  const bulkApply = useMutation({
    mutationFn: () =>
      apiPost<{ ok: boolean; applied: number; overwritten: number; failed: number }>("/api/flash-sales/bulk-apply", {
        denominationIds: Array.from(selected),
        discountPercent: discountPercent.trim(),
        startsAt,
        endsAt,
      }),
    onMutate: () => setFormError(null),
    onSuccess: (result) => {
      setDialogOpen(false);
      setSelected(new Set());
      setDiscountPercent("");
      setStartsAt("");
      setEndsAt("");
      setResultMsg(
        `Applied to ${result.applied} of ${result.applied + result.failed} selected SKU(s)` +
          `${result.overwritten > 0 ? ` (${result.overwritten} replacing an existing schedule)` : ""}` +
          `${result.failed > 0 ? `; ${result.failed} failed.` : "."}`,
      );
      void qc.invalidateQueries({ queryKey: ["flash-sales", "denominations"] });
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const bulkEnd = useMutation({
    mutationFn: () =>
      apiPost<{ ok: boolean; cleared: number; skipped: number }>("/api/flash-sales/bulk-end", {
        denominationIds: Array.from(selected),
      }),
    onSuccess: (result) => {
      setSelected(new Set());
      setResultMsg(`Ended the flash sale on ${result.cleared} SKU(s).`);
      void qc.invalidateQueries({ queryKey: ["flash-sales", "denominations"] });
    },
  });

  if (isError) {
    return (
      <PageLayout title="Flash Sales">
        <p className="text-sm text-rust">Failed to load denominations.</p>
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Flash Sales">
      <PageHeader
        title="Flash Sales"
        description="Schedule and manage time-limited discounts across your catalog."
        actions={
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <Button size="sm" onClick={openNewFlashSale}>
              <Plus className="h-4 w-4" />
              New Flash Sale
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Set flash sale on {selected.size} SKU(s)</DialogTitle>
                <DialogDescription>
                  Applies the same discount and window to every selected SKU.
                  {alreadyScheduledCount > 0 &&
                    ` ${alreadyScheduledCount} of the ${selected.size} selected already have a schedule — this will replace it.`}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="text-sm font-medium text-ink">Discount %</label>
                  <Input
                    className="mt-1"
                    placeholder="e.g. 20"
                    value={discountPercent}
                    onChange={(e) => setDiscountPercent(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-ink">Starts</label>
                  <Input
                    className="mt-1"
                    type="datetime-local"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-ink">Ends</label>
                  <Input
                    className="mt-1"
                    type="datetime-local"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                  />
                </div>
                {formError && <p className="text-sm text-rust">{formError}</p>}
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button disabled={!canSubmit || bulkApply.isPending} onClick={() => bulkApply.mutate()}>
                  {bulkApply.isPending ? "Applying…" : "Apply"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Scheduled" value={scheduledCount} />
        <StatTile label="Running" value={runningCount} />
        <StatTile label="Expired" value={expiredCount} />
        <StatTile label="Discounted SKU" value={discountedCount} />
      </div>

      <FilterBar onClear={hasActiveFilter ? clearFilters : undefined} className="mb-4">
        <SearchBar
          value={filter}
          onChange={setFilter}
          placeholder="Filter by SKU, product, or category…"
          className="w-full sm:w-[380px]"
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
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Status</label>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger size="sm" className="w-36">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="scheduled">Scheduled</SelectItem>
              <SelectItem value="live">Running</SelectItem>
              <SelectItem value="ended">Expired</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Sort</label>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortMode)}>
            <SelectTrigger size="sm" className="w-36">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">SKU Name A–Z</SelectItem>
              <SelectItem value="discount">Discount % (High–Low)</SelectItem>
              <SelectItem value="product">Product Name</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </FilterBar>

      {resultMsg && <p className="mb-3 text-sm text-ink-soft">{resultMsg}</p>}

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
          <span className="text-ink-soft">{selected.size} selected</span>
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            Set flash sale…
          </Button>
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="outline" className="text-rust">
                End now
              </Button>
            }
            title="End the flash sale on the selected SKUs?"
            description={`Cancel the flash sale on ${selected.size} SKU(s). They'll revert to their base price immediately. SKUs with no active schedule are skipped.`}
            confirmLabel="End now"
            onConfirm={() => bulkEnd.mutate()}
          />
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <DataTable
        columns={[
          {
            key: "select",
            header: (
              <Checkbox
                checked={allFilteredSelected}
                onCheckedChange={toggleSelectAllFiltered}
                aria-label="Select all SKUs matching the current filters"
              />
            ),
            render: (row) => (
              <Checkbox
                checked={selected.has(row.id)}
                onCheckedChange={() => toggleSelected(row.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ${row.name}`}
              />
            ),
          },
          {
            key: "sku",
            header: "SKU",
            render: (row) => (
              <div>
                <div className="font-medium text-sm text-ink">{row.name}</div>
                <div className="text-xs text-ink-soft">{row.categoryName ?? "—"}</div>
              </div>
            ),
          },
          {
            key: "product",
            header: "Product",
            render: (row) => <span className="text-sm text-ink-soft">{row.productName}</span>,
          },
          {
            key: "price",
            header: "Price",
            render: (row) =>
              row.flash ? (
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs text-ink-faint line-through">
                    {formatCurrencyDisplay(row.price, "IDR")}
                  </span>
                  <span className="font-mono text-sm font-medium text-ink">
                    {formatCurrencyDisplay(flashPriceOf(row), "IDR")}
                  </span>
                  <span className="text-xs font-medium text-grass-dark">-{row.flash.discountPercent}%</span>
                </div>
              ) : (
                <span className="font-mono text-sm">{formatCurrencyDisplay(row.price, "IDR")}</span>
              ),
          },
          {
            key: "window",
            header: "Window",
            render: (row) => (
              <span className="text-sm text-ink-soft">{row.flash?.windowDisplay ?? "—"}</span>
            ),
          },
          {
            key: "status",
            header: "Flash Status",
            render: (row) => (
              <StatusBadge status={row.flash ? STATUS_BADGE[row.flash.status] : STATUS_BADGE.inactive} />
            ),
          },
        ]}
        data={filtered}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        empty={
          <EmptyState
            icon={Zap}
            title="No SKUs found"
            description="Try adjusting your search or filters."
            secondaryAction={hasActiveFilter ? { label: "Clear Filters", onClick: clearFilters } : undefined}
          />
        }
      />
    </PageLayout>
  );
}
