import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { AlertCircle, Package } from "lucide-react";
import { apiGet, apiPost } from "../api/client";

interface CategoryRow {
  id: number;
  name: string;
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

export function CatalogPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } = useCatalog();
  const [filter, setFilter] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [togglingProduct, setTogglingProduct] = useState<Set<number>>(new Set());
  const queryClient = useQueryClient();

  async function toggleProductActive(id: number, active: boolean) {
    setTogglingProduct((s) => new Set([...s, id]));
    try {
      await apiPost(`/api/catalog/products/${id}/active`, { active });
      await queryClient.invalidateQueries({ queryKey: ["catalog"] });
    } finally {
      setTogglingProduct((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
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

      <FilterBar
        onClear={filter ? () => setFilter("") : undefined}
        className="mb-4"
      >
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by product or category…"
          className="w-64"
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

      <DataTable
        columns={[
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
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/catalog/${row.id}`);
                }}
              >
                Edit
              </Button>
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
