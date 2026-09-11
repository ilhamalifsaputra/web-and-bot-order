import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { SearchBar } from "../components/shared/SearchBar";
import { StatTile } from "../components/shared/StatTile";
import { UrgencyDot } from "../components/shared/UrgencyDot";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  Check,
  MoreVertical,
  Package,
  Plus,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { apiPost, apiDelete } from "../api/client";
import { useCatalog, type ProductRow } from "../api/catalog";
import { describeError } from "../lib/errorMessages";
import { visibleSelection } from "../lib/selection";

interface ImportPreviewRow {
  ok: boolean;
  error?: string;
  category?: string;
  product?: string;
  denomination?: string;
  price?: string;
  line: number;
}

interface ImportPreview {
  rows: ImportPreviewRow[];
  validCount: number;
  invalidCount: number;
  csv: string;
}

type StatusFilter = "all" | "active" | "inactive" | "archived";
type SortMode = "name" | "newest" | "category";

/** Order comparator for the Sort filter — "name" is the default/stable order. */
function compareProducts(a: ProductRow, b: ProductRow, sortBy: SortMode): number {
  if (sortBy === "newest") {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  }
  if (sortBy === "category") {
    return (
      (a.category?.name ?? "").localeCompare(b.category?.name ?? "") ||
      a.name.localeCompare(b.name)
    );
  }
  return a.name.localeCompare(b.name);
}

export function CatalogPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } = useCatalog();
  const [filter, setFilter] = useState("");
  // Seeded from ?categoryId= so the product-count links on /categories land on
  // this list already narrowed to that category.
  const [searchParams, setSearchParams] = useSearchParams();
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get("categoryId") ?? "all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortMode>("name");
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [togglingProduct, setTogglingProduct] = useState<Set<number>>(new Set());
  const [togglingArchive, setTogglingArchive] = useState<Set<number>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<ProductRow | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);
  const queryClient = useQueryClient();

  /** Keep ?categoryId= in step with the filter, so the narrowed list stays
   *  shareable and the browser's Back button undoes the narrowing. */
  function changeCategoryFilter(value: string) {
    setCategoryFilter(value);
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete("categoryId");
    else next.set("categoryId", value);
    setSearchParams(next, { replace: true });
  }

  // Catalog filters client-side, so a selection surviving a filter change would
  // let a bulk action silently apply to products no longer on screen. `sortBy`
  // is deliberately absent: it reorders the visible rows without changing which
  // rows are visible, so clearing on a sort change would only surprise.
  useEffect(() => {
    setSelected(new Set());
  }, [filter, categoryFilter, statusFilter]);

  const invalidateCatalog = () => queryClient.invalidateQueries({ queryKey: ["catalog"] });

  async function toggleProductActive(id: number, active: boolean) {
    setTogglingProduct((s) => new Set([...s, id]));
    try {
      await apiPost(`/api/catalog/products/${id}/active`, { active });
      await invalidateCatalog();
    } finally {
      setTogglingProduct((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }

  async function toggleProductArchived(id: number, archived: boolean) {
    setTogglingArchive((s) => new Set([...s, id]));
    try {
      await apiPost(`/api/catalog/products/${id}/archive`, { archived });
      await invalidateCatalog();
    } finally {
      setTogglingArchive((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }

  async function deleteProduct(id: number) {
    try {
      await apiDelete(`/api/catalog/products/${id}`);
      await invalidateCatalog();
      toast.success("Product deleted.");
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to delete product."));
    }
  }

  function toggleSelected(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  // Takes an explicit `ids` argument rather than reading the derived selection
  // from closure: that binding is declared past this point, below the early
  // returns, so a future caller from anywhere but the bulk toolbar would hit a
  // temporal dead zone. Matches how StockProductPage and FlashSalesPage do it.
  async function bulkSetActive(active: boolean, ids: number[]) {
    const count = ids.length;
    setBulkActing(true);
    try {
      await apiPost("/api/catalog/products/bulk-active", { ids, active });
      setSelected(new Set());
      await invalidateCatalog();
      toast.success(`${count} product(s) ${active ? "activated" : "deactivated"}.`);
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to update products."));
    } finally {
      setBulkActing(false);
    }
  }

  async function bulkSetArchived(archived: boolean, ids: number[]) {
    const count = ids.length;
    setBulkActing(true);
    try {
      await apiPost("/api/catalog/products/bulk-archive", { ids, archived });
      setSelected(new Set());
      await invalidateCatalog();
      toast.success(`${count} product(s) ${archived ? "archived" : "unarchived"}.`);
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to update products."));
    } finally {
      setBulkActing(false);
    }
  }

  async function bulkSetCategory(categoryId: number, ids: number[]) {
    const category = categories.find((c) => c.id === categoryId);
    setBulkActing(true);
    try {
      const res = await apiPost<{ count: number }>("/api/catalog/products/bulk-category", {
        ids,
        categoryId,
      });
      setSelected(new Set());
      await invalidateCatalog();
      toast.success(`${res.count} product(s) moved to "${category?.name ?? "the category"}".`);
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to move products."));
    } finally {
      setBulkActing(false);
    }
  }

  const handlePreview = async () => {
    setImportError(null);
    try {
      const res = await apiPost<ImportPreview>("/api/catalog/products/import", { csv });
      setPreview(res);
    } catch (err) {
      setImportError((err as Error).message);
    }
  };

  const handleApply = async () => {
    if (!preview) return;
    setImporting(true);
    try {
      await apiPost("/api/catalog/products/import/apply", { csv: preview.csv });
      await queryClient.invalidateQueries({ queryKey: ["catalog"] });
      setShowImport(false);
      setCsv("");
      setPreview(null);
    } catch (err) {
      setImportError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  if (isError) {
    return (
      <PageLayout title="Catalog">
        <EmptyState
          icon={AlertCircle}
          title="Failed to load catalog"
          description="An error occurred while loading the catalog. Please try again."
          action={{
            label: "Retry",
            onClick: () => void refetch(),
          }}
        />
      </PageLayout>
    );
  }

  const products = data?.products ?? [];
  const categories = data?.categories ?? [];
  const nonArchived = products.filter((p) => !p.isArchived);

  const stats = {
    products: nonArchived.length,
    categories: categories.length,
    variants: nonArchived.reduce((sum, p) => sum + p._count.denominations, 0),
    active: nonArchived.filter((p) => p.isActive).length,
    inactive: nonArchived.filter((p) => !p.isActive).length,
  };

  const hasActiveFilter =
    !!filter || categoryFilter !== "all" || statusFilter !== "all" || sortBy !== "name";
  const clearFilters = () => {
    setFilter("");
    changeCategoryFilter("all");
    setStatusFilter("all");
    setSortBy("name");
  };

  const filtered = products
    .filter(
      (p) =>
        !filter ||
        p.name.toLowerCase().includes(filter.toLowerCase()) ||
        (p.category?.name ?? "").toLowerCase().includes(filter.toLowerCase()),
    )
    .filter((p) => categoryFilter === "all" || p.category?.id === Number(categoryFilter))
    .filter((p) => {
      if (statusFilter === "archived") return p.isArchived;
      if (p.isArchived) return false; // archived only shows under the explicit "Archived" filter
      if (statusFilter === "active") return p.isActive;
      if (statusFilter === "inactive") return !p.isActive;
      return true;
    })
    .sort((a, b) => compareProducts(a, b, sortBy));

  // Catalog has no pagination, so the filtered list is the page: select-all
  // spans exactly the rows on screen.
  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id));
  // What the bulk bar counts and the bulk actions act on. The clearing effect
  // above covers filter changes; this covers a product leaving `filtered`
  // through a data change, which no filter state records.
  const visibleSelected = visibleSelection(selected, filtered, (p) => p.id);
  function toggleSelectAllFiltered() {
    setSelected((prev) => {
      // Deselecting drops everything rather than pruning only the visible ids:
      // identical in normal use (the clearing effect keeps the selection within
      // `filtered`), but self-healing if a row left the filtered set through a
      // data change instead of a filter change — pruning would strand its id
      // and leave the bulk bar counting a product nobody can see.
      if (allFilteredSelected) return new Set();
      const next = new Set(prev);
      filtered.forEach((p) => next.add(p.id));
      return next;
    });
  }

  return (
    <PageLayout title="Catalog">
      <PageHeader
        title="Catalog"
        description="Manage products and their variants."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate("/categories")}>
              Manage categories
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowImport(!showImport);
                setPreview(null);
                setCsv("");
              }}
            >
              Import CSV
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate("/catalog/digiflazz-sync")}>
              Sync Digiflazz
            </Button>
            <Button size="sm" onClick={() => navigate("/catalog/new")}>
              <Plus className="h-4 w-4" />
              Add Product
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Products" value={stats.products} />
        <StatTile
          label="Categories"
          value={stats.categories}
          onClick={() => navigate("/categories")}
        />
        <StatTile label="Variants" value={stats.variants} />
        <StatTile label="Active" value={stats.active} />
        <StatTile label="Inactive" value={stats.inactive} />
      </div>

      <FilterBar onClear={hasActiveFilter ? clearFilters : undefined} className="mb-4">
        <SearchBar
          value={filter}
          onChange={setFilter}
          placeholder="Filter by product or category…"
          className="w-full sm:w-[380px]"
        />
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Category</label>
          <Select value={categoryFilter} onValueChange={changeCategoryFilter}>
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
          <label className="text-xs text-ink-soft">Status</label>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger size="sm" className="w-36">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
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
              <SelectItem value="name">Name A–Z</SelectItem>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="category">Category</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </FilterBar>

      {showImport && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Import denominations from CSV</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-ink-soft">
              Format: category|product|denomination|type|duration|price
            </p>
            <Textarea
              rows={6}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setPreview(null);
              }}
              placeholder="Seed Category|Product Name|1GB|PRIVATE|30 days|50000"
              className="font-mono text-sm"
            />
            {importError && (
              <p className="text-sm text-rust">{importError}</p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void handlePreview()}
                disabled={!csv.trim()}
              >
                Preview
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowImport(false);
                  setPreview(null);
                  setCsv("");
                }}
              >
                Cancel
              </Button>
            </div>

            {preview && (
              <div>
                <p className="text-sm mb-2">
                  <span className="text-grass">{preview.validCount} valid</span>
                  {preview.invalidCount > 0 && (
                    <span className="text-rust ml-2">
                      {preview.invalidCount} invalid
                    </span>
                  )}
                </p>
                <DataTable
                  columns={[
                    { key: "line", header: "#", render: (row) => row.line },
                    {
                      key: "status",
                      header: "Status",
                      render: (row) =>
                        row.ok ? (
                          <Check className="h-4 w-4 text-grass" />
                        ) : (
                          <X className="h-4 w-4 text-rust" />
                        ),
                    },
                    { key: "category", header: "Category", render: (row) => row.category ?? "" },
                    { key: "product", header: "Product", render: (row) => row.product ?? "" },
                    { key: "denomination", header: "Denomination", render: (row) => row.denomination ?? "" },
                    { key: "price", header: "Price", render: (row) => row.price ?? "" },
                    {
                      key: "error",
                      header: "Error",
                      render: (row) => (
                        <span
                          className={cn("block max-w-[320px] truncate", row.ok ? "" : "text-rust")}
                          title={row.error ?? undefined}
                        >
                          {row.error ?? ""}
                        </span>
                      ),
                    },
                  ]}
                  data={preview.rows}
                  keyExtractor={(row) => row.line}
                  empty={<EmptyState title="No rows to preview." />}
                />
                {preview.validCount > 0 && (
                  <Button
                    size="sm"
                    className="mt-3"
                    onClick={() => void handleApply()}
                    disabled={importing}
                  >
                    {importing
                      ? "Importing…"
                      : `Import ${preview.validCount} denomination(s)`}
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {visibleSelected.size > 0 && (
        <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
          <span className="text-ink-soft">{visibleSelected.size} selected</span>
          <Button size="sm" variant="outline" disabled={bulkActing} onClick={() => void bulkSetActive(true, Array.from(visibleSelected))}>
            Activate
          </Button>
          <Button size="sm" variant="outline" disabled={bulkActing} onClick={() => void bulkSetActive(false, Array.from(visibleSelected))}>
            Deactivate
          </Button>
          <Button size="sm" variant="outline" disabled={bulkActing} onClick={() => void bulkSetArchived(true, Array.from(visibleSelected))}>
            Archive
          </Button>
          <Select
            value=""
            disabled={bulkActing || categories.length === 0}
            onValueChange={(v) => void bulkSetCategory(Number(v), Array.from(visibleSelected))}
          >
            <SelectTrigger size="sm" className="w-[190px]" aria-label="Move to category">
              <SelectValue placeholder="Move to category…" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((cat) => (
                <SelectItem key={cat.id} value={String(cat.id)}>
                  {cat.emoji ? `${cat.emoji} ` : ""}
                  {cat.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <DataTable
        columns={[
          {
            key: "select",
            kind: "selection",
            header: (
              <Checkbox
                checked={allFilteredSelected}
                onCheckedChange={toggleSelectAllFiltered}
                disabled={filtered.length === 0}
                aria-label="Select all products matching the current filters"
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
            key: "name",
            header: "Product",
            className: "py-3",
            render: (row) => (
              <div className="flex items-center gap-3">
                {row.webImageUrl ? (
                  <img
                    src={row.webImageUrl}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sand text-lg"
                    aria-hidden="true"
                  >
                    {row.category?.emoji || <Package className="h-4 w-4 text-ink-faint" />}
                  </div>
                )}
                <div className="min-w-0 max-w-[240px]">
                  <div className="truncate text-sm font-medium text-ink" title={row.name}>
                    {row.name}
                  </div>
                  <div
                    className="truncate text-xs text-ink-soft"
                    title={row.category?.name ?? undefined}
                  >
                    {row.category?.name ?? "—"}
                  </div>
                </div>
              </div>
            ),
          },
          {
            key: "denominations",
            header: "Denominations",
            render: (row) => (
              <span className="text-sm text-ink-soft">
                {row._count.denominations}
              </span>
            ),
          },
          {
            key: "active",
            header: "Status",
            className: "py-3",
            render: (row) => (
              <div className="flex items-center gap-2">
                <UrgencyDot level={row.isActive ? "ok" : "idle"} />
                <span className="w-14 text-sm text-ink-soft">
                  {row.isActive ? "Active" : "Inactive"}
                </span>
                <Switch
                  checked={row.isActive}
                  onCheckedChange={(checked) => void toggleProductActive(row.id, checked)}
                  disabled={togglingProduct.has(row.id)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            ),
          },
          {
            key: "actions",
            header: "",
            render: (row) => (
              <div onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name}`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => navigate(`/catalog/${row.id}`)}>
                      <SquarePen className="h-4 w-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={togglingArchive.has(row.id)}
                      onSelect={() => void toggleProductArchived(row.id, !row.isArchived)}
                    >
                      {row.isArchived ? (
                        <ArchiveRestore className="h-4 w-4" />
                      ) : (
                        <Archive className="h-4 w-4" />
                      )}
                      {row.isArchived ? "Unarchive" : "Archive"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={(e) => {
                        e.preventDefault();
                        setPendingDelete(row);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ),
          },
        ]}
        data={filtered}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => navigate(`/catalog/${row.id}`)}
        empty={
          hasActiveFilter ? (
            <EmptyState
              icon={Package}
              title="No products match your filters"
              description="Try adjusting or clearing your filters."
              secondaryAction={{ label: "Clear Filters", onClick: clearFilters }}
            />
          ) : (
            <EmptyState
              icon={Package}
              title="No products yet"
              description="Add your first product to start selling."
              action={{ label: "Add Product", onClick: () => navigate("/catalog/new") }}
              secondaryAction={{
                label: "Import CSV",
                onClick: () => {
                  setShowImport(true);
                  setPreview(null);
                  setCsv("");
                },
              }}
            />
          )
        }
      />

      {pendingDelete && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
          title="Delete this product?"
          description={`Delete "${pendingDelete.name}". This is refused if it still has denominations.`}
          confirmLabel="Delete"
          onConfirm={() => deleteProduct(pendingDelete.id)}
        />
      )}
    </PageLayout>
  );
}
