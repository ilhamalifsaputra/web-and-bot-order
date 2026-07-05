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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { AlertCircle, Package } from "lucide-react";
import { apiGet, apiPost, apiPatch, apiDelete } from "../api/client";

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
  category: { id: number; name: string } | null;
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

function useCatalog() {
  return useQuery<CatalogData>({
    queryKey: ["catalog"],
    queryFn: async () => apiGet<CatalogData>("/api/catalog"),
  });
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
  const [showCategories, setShowCategories] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [togglingProduct, setTogglingProduct] = useState<Set<number>>(new Set());
  const [togglingCategory, setTogglingCategory] = useState<Set<number>>(new Set());
  const [editingCategory, setEditingCategory] = useState<CategoryRow | null>(null);
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

  async function deleteProduct(id: number) {
    try {
      await apiDelete(`/api/catalog/products/${id}`);
      await invalidateCatalog();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete product.");
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
    setBulkActing(true);
    try {
      await apiPost("/api/catalog/products/bulk-active", { ids: Array.from(selected), active });
      setSelected(new Set());
      await invalidateCatalog();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to update products.");
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

  const filtered = (data?.products ?? []).filter(
    (p) =>
      !filter ||
      p.name.toLowerCase().includes(filter.toLowerCase()) ||
      (p.category?.name ?? "").toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <PageLayout title="Catalog">
      <PageHeader
        title="Catalog"
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
              + Add Product
            </Button>
          </div>
        }
      />

      {showCategories && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Categories</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-line">
            {(data?.categories ?? []).map((cat) => (
              <div key={cat.id} className="flex items-center justify-between py-2">
                <span className="text-sm text-ink">{cat.emoji ? `${cat.emoji} ` : ""}{cat.name}</span>
                <div className="flex items-center gap-3">
                  <Switch
                    aria-label={`${cat.name} active`}
                    checked={cat.isActive}
                    onCheckedChange={(checked) => void toggleCategoryActive(cat.id, checked)}
                    disabled={togglingCategory.has(cat.id)}
                  />
                  <Button variant="ghost" size="sm" onClick={() => setEditingCategory(cat)}>
                    Edit category
                  </Button>
                </div>
              </div>
            ))}
            {(data?.categories ?? []).length === 0 && (
              <p className="text-sm text-ink-soft py-2">No categories yet.</p>
            )}
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

      <FilterBar
        onClear={filter ? () => setFilter("") : undefined}
        className="mb-4"
      >
        <SearchBar
          value={filter}
          onChange={setFilter}
          placeholder="Filter by product or category…"
        />
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
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead>Denomination</TableHead>
                        <TableHead>Price</TableHead>
                        <TableHead>Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.rows.map((row) => (
                        <TableRow
                          key={row.line}
                          className={row.ok ? "" : "text-rust"}
                        >
                          <TableCell>{row.line}</TableCell>
                          <TableCell>{row.ok ? "✓" : "✗"}</TableCell>
                          <TableCell>{row.category ?? ""}</TableCell>
                          <TableCell>{row.product ?? ""}</TableCell>
                          <TableCell>{row.denomination ?? ""}</TableCell>
                          <TableCell>{row.price ?? ""}</TableCell>
                          <TableCell>{row.error ?? ""}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
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
        <div className="mb-3 flex items-center gap-3 rounded-md border border-line bg-card px-3 py-2 text-sm">
          <span className="text-ink-soft">{selected.size} selected</span>
          <Button size="sm" variant="outline" disabled={bulkActing} onClick={() => void bulkSetActive(true)}>
            Activate
          </Button>
          <Button size="sm" variant="outline" disabled={bulkActing} onClick={() => void bulkSetActive(false)}>
            Deactivate
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
              <input
                type="checkbox"
                checked={selected.has(row.id)}
                onChange={() => toggleSelected(row.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ${row.name}`}
              />
            ),
          },
          {
            key: "name",
            header: "Product",
            render: (row) => (
              <div>
                <div className="font-medium text-sm text-ink">{row.name}</div>
                <div className="text-xs text-ink-soft">
                  {row.category?.name ?? "—"}
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
            render: (row) => (
              <Switch
                checked={row.isActive}
                onCheckedChange={(checked) => void toggleProductActive(row.id, checked)}
                disabled={togglingProduct.has(row.id)}
                onClick={(e) => e.stopPropagation()}
              />
            ),
          },
          {
            key: "actions",
            header: "",
            render: (row) => (
              <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate(`/catalog/${row.id}`)}
                >
                  Edit
                </Button>
                <ConfirmDialog
                  trigger={<Button variant="ghost" size="sm" className="text-rust">Delete</Button>}
                  title="Delete this product?"
                  description={`Delete "${row.name}". This is refused if it still has denominations.`}
                  confirmLabel="Delete"
                  onConfirm={() => deleteProduct(row.id)}
                />
              </div>
            ),
          },
        ]}
        data={filtered}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => navigate(`/catalog/${row.id}`)}
        empty={
          <EmptyState
            icon={Package}
            title="No products yet"
            description="Add your first product to start selling."
          />
        }
      />
    </PageLayout>
  );
}
