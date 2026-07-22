import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { StatusBadge } from "../components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Zap } from "lucide-react";
import { apiGet, apiPost } from "../api/client";

interface FlashInfo {
  discountPercent: string;
  windowDisplay: string;
  status: "live" | "scheduled" | "ended";
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

function useFlashSaleDenominations() {
  return useQuery<{ denominations: DenominationRow[] }>({
    queryKey: ["flash-sales", "denominations"],
    queryFn: () => apiGet("/api/flash-sales/denominations"),
  });
}

export function FlashSalesPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useFlashSaleDenominations();
  const [activeTab, setActiveTab] = useState<"apply" | "manage">("apply");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [discountPercent, setDiscountPercent] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  function changeTab(tab: string) {
    setActiveTab(tab as typeof activeTab);
    setSelected(new Set());
    setResultMsg(null);
  }

  // A stale selection surviving a new filter result set would let a bulk
  // action silently apply to rows no longer on screen — clear it whenever
  // the query changes.
  useEffect(() => {
    setSelected(new Set());
  }, [filter]);

  function toggleSelected(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const rows = data?.denominations ?? [];
  const filtered = rows.filter(
    (d) =>
      !filter ||
      d.name.toLowerCase().includes(filter.toLowerCase()) ||
      d.productName.toLowerCase().includes(filter.toLowerCase()) ||
      (d.categoryName ?? "").toLowerCase().includes(filter.toLowerCase()),
  );
  const scheduledRows = rows.filter((d) => d.flash !== null);

  const percentNumber = Number(discountPercent.trim());
  const percentIsValid =
    discountPercent.trim() !== "" && !Number.isNaN(percentNumber) && percentNumber > 0 && percentNumber <= 100;
  const canSubmit = percentIsValid && startsAt.trim() !== "" && endsAt.trim() !== "";
  const alreadyScheduledCount = Array.from(selected).filter((id) => rows.find((r) => r.id === id)?.flash).length;

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
      <PageHeader title="Flash Sales" />

      <Tabs value={activeTab} onValueChange={changeTab}>
        <TabsList>
          <TabsTrigger value="apply">Apply</TabsTrigger>
          <TabsTrigger value="manage">Active &amp; Scheduled ({scheduledRows.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="apply">
          <FilterBar onClear={filter ? () => setFilter("") : undefined} className="mb-4">
            <SearchBar value={filter} onChange={setFilter} placeholder="Filter by SKU, product, or category…" />
          </FilterBar>

          {resultMsg && <p className="mb-3 text-sm text-ink-soft">{resultMsg}</p>}

          {selected.size > 0 && (
            <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
              <span className="text-ink-soft">{selected.size} selected</span>
              <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline">Set flash sale…</Button>
                </DialogTrigger>
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
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          <DataTable
            columns={[
              {
                key: "select",
                header: "",
                render: (row) => (
                  <Checkbox
                    checked={selected.has(row.id)}
                    onCheckedChange={() => toggleSelected(row.id)}
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
              { key: "product", header: "Product", render: (row) => <span className="text-sm text-ink-soft">{row.productName}</span> },
              { key: "price", header: "Price", render: (row) => <span className="font-mono text-sm">{row.price}</span> },
              {
                key: "status",
                header: "Flash Status",
                render: (row) =>
                  row.flash ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
                      <StatusBadge status={row.flash.status.toUpperCase()} />
                      {row.flash.discountPercent}%
                    </span>
                  ) : (
                    <span className="text-xs text-ink-faint">—</span>
                  ),
              },
            ]}
            data={filtered}
            isLoading={isLoading}
            keyExtractor={(row) => row.id}
            empty={<EmptyState icon={Zap} title="No SKUs found" description="Try adjusting your filter." />}
          />
        </TabsContent>

        <TabsContent value="manage">
          {resultMsg && <p className="mb-3 text-sm text-ink-soft">{resultMsg}</p>}

          {selected.size > 0 && (
            <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
              <span className="text-ink-soft">{selected.size} selected</span>
              <ConfirmDialog
                trigger={<Button size="sm" variant="outline" className="text-rust">End now</Button>}
                title="End the flash sale on the selected SKUs?"
                description={`Cancel the flash sale on ${selected.size} SKU(s). They'll revert to their base price immediately.`}
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
                header: "",
                render: (row) => (
                  <Checkbox
                    checked={selected.has(row.id)}
                    onCheckedChange={() => toggleSelected(row.id)}
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
                    <div className="text-xs text-ink-soft">{row.productName}</div>
                  </div>
                ),
              },
              { key: "discount", header: "Discount", render: (row) => <span className="text-sm">{row.flash!.discountPercent}%</span> },
              { key: "window", header: "Window", render: (row) => <span className="text-sm text-ink-soft">{row.flash!.windowDisplay}</span> },
              { key: "status", header: "Status", render: (row) => <StatusBadge status={row.flash!.status.toUpperCase()} /> },
            ]}
            data={scheduledRows}
            isLoading={isLoading}
            keyExtractor={(row) => row.id}
            empty={<EmptyState icon={Zap} title="No active or scheduled flash sales" />}
          />
        </TabsContent>
      </Tabs>
    </PageLayout>
  );
}
