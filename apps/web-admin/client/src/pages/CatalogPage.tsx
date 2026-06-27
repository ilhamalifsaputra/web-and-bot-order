import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { apiPost } from "../api/client";

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
    queryFn: async () => {
      const res = await fetch("/api/catalog");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<CatalogData>;
    },
  });
}

export function CatalogPage() {
  const navigate = useNavigate();
  const { data, isError } = useCatalog();
  const [filter, setFilter] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const queryClient = useQueryClient();

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
        <p style={{ color: "red" }}>Failed to load catalog.</p>
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
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by product or category…"
          style={{ flex: 1, padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4 }}
        />
        {filter && (
          <button
            type="button"
            onClick={() => setFilter("")}
            style={{ padding: "6px 12px" }}
          >
            Clear
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          onClick={() => {
            setShowImport(!showImport);
            setPreview(null);
            setCsv("");
          }}
        >
          Import CSV
        </button>
      </div>

      {showImport && (
        <div className="card card-pad mt-4">
          <h3 className="section-title mb-3">Import denominations from CSV</h3>
          <p className="text-sm text-ink-soft mb-2">
            Format: category|product|denomination|type|duration|price
          </p>
          <textarea
            className="field font-mono text-sm"
            rows={6}
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setPreview(null);
            }}
            placeholder="Seed Category|Product Name|1GB|PRIVATE|30 days|50000"
          />
          {importError && (
            <p className="text-sm text-danger mt-2">{importError}</p>
          )}
          <div className="flex gap-2 mt-3">
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => void handlePreview()}
              disabled={!csv.trim()}
            >
              Preview
            </button>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                setShowImport(false);
                setPreview(null);
                setCsv("");
              }}
            >
              Cancel
            </button>
          </div>
          {preview && (
            <div className="mt-4">
              <p className="text-sm mb-2">
                <span className="text-success">{preview.validCount} valid</span>
                {preview.invalidCount > 0 && (
                  <span className="text-danger ml-2">
                    {preview.invalidCount} invalid
                  </span>
                )}
              </p>
              <div className="overflow-x-auto">
                <table className="data-table text-sm">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Status</th>
                      <th>Category</th>
                      <th>Product</th>
                      <th>Denomination</th>
                      <th>Price</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.line} className={row.ok ? "" : "text-danger"}>
                        <td>{row.line}</td>
                        <td>{row.ok ? "✓" : "✗"}</td>
                        <td>{row.category ?? ""}</td>
                        <td>{row.product ?? ""}</td>
                        <td>{row.denomination ?? ""}</td>
                        <td>{row.price ?? ""}</td>
                        <td>{row.error ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.validCount > 0 && (
                <button
                  className="btn btn-primary btn-sm mt-3"
                  type="button"
                  onClick={() => void handleApply()}
                  disabled={importing}
                >
                  {importing
                    ? "Importing…"
                    : `Import ${preview.validCount} denomination(s)`}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {!data ? (
        <p>Loading…</p>
      ) : filtered.length === 0 ? (
        <p>No products found.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Product</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Category</th>
              <th style={{ textAlign: "center", padding: "6px 8px" }}>Denominations</th>
              <th style={{ textAlign: "center", padding: "6px 8px" }}>Active</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr
                key={p.id}
                style={{
                  borderTop: "1px solid #eee",
                  cursor: "pointer",
                  background: p.isActive ? undefined : "#fafafa",
                  color: p.isActive ? undefined : "#999",
                }}
                onClick={() => navigate(`/catalog/${p.id}`)}
              >
                <td style={{ padding: "6px 8px" }}>{p.name}</td>
                <td style={{ padding: "6px 8px" }}>{p.category?.name ?? "—"}</td>
                <td style={{ padding: "6px 8px", textAlign: "center" }}>
                  {p._count.denominations}
                </td>
                <td style={{ padding: "6px 8px", textAlign: "center" }}>
                  {p.isActive ? "Yes" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageLayout>
  );
}
