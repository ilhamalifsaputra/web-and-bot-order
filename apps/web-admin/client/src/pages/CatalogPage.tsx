import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { SearchBar } from "../components/shared/SearchBar";
import { StatTile } from "../components/shared/StatTile";
import { UrgencyDot } from "../components/shared/UrgencyDot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { apiGet, apiPost, apiPatch, apiDelete } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface CategoryRow {
  id: number;
  name: string;
  emoji: string | null;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
}

interface ProductRow {
  id: number;
  name: string;
  isActive: boolean;
  isArchived: boolean;
  webImageUrl: string | null;
  createdAt: string;
  category: { id: number; name: string; emoji: string | null } | null;
  _count: { denominations: number };
}

interface CatalogData {
  categories: CategoryRow[];
  products: ProductRow[];
}

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

function useCatalog() {
  return useQuery<CatalogData>({
    queryKey: ["catalog"],
    queryFn: async () => apiGet<CatalogData>("/api/catalog"),
  });
}

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

function CategoryEditDialog({
  category,
  onClose,
  onSaved,
}: {
  category: CategoryRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [emoji, setEmoji] = useState(category.emoji ?? "");
  const [description, setDescription] = useState(category.description ?? "");
  const [sortOrder, setSortOrder] = useState(String(category.sortOrder));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`/api/catalog/categories/${category.id}`, {
        name,
        emoji: emoji || null,
        description: description || null,
        sortOrder: Number(sortOrder) || 0,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save category.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit category</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="cat-name">Name</Label>
            <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="cat-emoji">Emoji</Label>
            <Input id="cat-emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} className="max-w-[100px]" />
          </div>
          <div>
            <Label htmlFor="cat-desc">Description</Label>
            <Textarea id="cat-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="cat-sort">Sort order</Label>
            <Input id="cat-sort" type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="max-w-[100px]" />
          </div>
          {error && <p className="text-sm text-rust">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CatalogPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } = useCatalog();
  const [filter, setFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortMode>("name");
  const [showCategories, setShowCategories] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [togglingProduct, setTogglingProduct] = useState<Set<number>>(new Set());
  const [togglingCategory, setTogglingCategory] = useState<Set<number>>(new Set());
  const [togglingArchive, setTogglingArchive] = useState<Set<number>>(new Set());
  const [editingCategory, setEditingCategory] = useState<CategoryRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProductRow | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);
  const queryClient = useQueryClient();

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

  async function toggleCategoryActive(id: number, active: boolean) {
    setTogglingCategory((s) => new Set([...s, id]));
    try {
      await apiPost(`/api/catalog/categories/${id}/active`, { active });
      await invalidateCatalog();
    } finally {
      setTogglingCategory((s) => {
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

  async function bulkSetActive(active: boolean) {
    const count = selected.size;
    setBulkActing(true);
    try {
      await apiPost("/api/catalog/products/bulk-active", { ids: Array.from(selected), active });
      setSelected(new Set());
      await invalidateCatalog();
      toast.success(`${count} product(s) ${active ? "activated" : "deactivated"}.`);
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to update products."));
    } finally {
      setBulkActing(false);
    }
  }

  async function bulkSetArchived(archived: boolean) {
    const count = selected.size;
    setBulkActing(true);
    try {
      await apiPost("/api/catalog/products/bulk-archive", { ids: Array.from(selected), archived });
      setSelected(new Set());
      await invalidateCatalog();
      toast.success(`${count} product(s) ${archived ? "archived" : "unarchived"}.`);
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to update products."));
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
    setCategoryFilter("all");
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

  return (
    <PageLayout title="Catalog">
      <PageHeader
        title="Catalog"
        description="Manage products, variants and categories."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowCategories(!showCategories)}
            >
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
            <Button size="sm" onClick={() => navigate("/catalog/new")}>
              <Plus className="h-4 w-4" />
              Add Product
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Products" value={stats.products} />
        <StatTile label="Categories" value={stats.categories} />
        <StatTile label="Variants" value={stats.variants} />
        <StatTile label="Active" value={stats.active} />
        <StatTile label="Inactive" value={stats.inactive} />
      </div>

      {showCategories && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Categories</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {categories.map((cat) => {
                const count = nonArchived.filter((p) => p.category?.id === cat.id).length;
                return (
                  <div
                    key={cat.id}
                    className="flex shrink-0 items-center gap-2 rounded-4xl border border-line bg-sand px-3 py-1.5 text-sm"
                  >
                    <span className="whitespace-nowrap text-ink">
                      {cat.emoji ? `${cat.emoji} ` : ""}
                      {cat.name} <span className="text-ink-soft">({count})</span>
                    </span>
                    <Switch
                      aria-label={`${cat.name} active`}
                      checked={cat.isActive}
                      onCheckedChange={(checked) => void toggleCategoryActive(cat.id, checked)}
                      disabled={togglingCategory.has(cat.id)}
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Edit category"
                      onClick={() => setEditingCategory(cat)}
                    >
                      <SquarePen className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
              {categories.length === 0 && (
                <p className="py-2 text-sm text-ink-soft">No categories yet.</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {editingCategory && (
        <CategoryEditDialog
          category={editingCategory}
          onClose={() => setEditingCategory(null)}
          onSaved={() => void invalidateCatalog()}
        />
      )}

      <FilterBar onClear={hasActiveFilter ? clearFilters : undefined} className="mb-4">
        <SearchBar
          value={filter}
          onChange={setFilter}
          placeholder="Filter by product or category…"
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
                      render: (row) => <span className={row.ok ? "" : "text-rust"}>{row.error ?? ""}</span>,
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

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
          <span className="text-ink-soft">{selected.size} selected</span>
          <Button size="sm" variant="outline" disabled={bulkActing} onClick={() => void bulkSetActive(true)}>
            Activate
          </Button>
          <Button size="sm" variant="outline" disabled={bulkActing} onClick={() => void bulkSetActive(false)}>
            Deactivate
          </Button>
          <Button size="sm" variant="outline" disabled={bulkActing} onClick={() => void bulkSetArchived(true)}>
            Archive
          </Button>
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
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{row.name}</div>
                  <div className="truncate text-xs text-ink-soft">
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
