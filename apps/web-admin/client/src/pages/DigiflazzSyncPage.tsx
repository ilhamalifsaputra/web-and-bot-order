import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { toast } from "sonner";
import { apiPost, apiGet } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface SkuRow {
  buyerSkuCode: string;
  productName: string;
  costPrice: string;
  suggestedPrice: string;
}
interface BrandGroup {
  brand: string;
  existingProductId: number | null;
  skus: SkuRow[];
}
interface PreviewResponse {
  groups: BrandGroup[];
}
interface Category {
  id: number;
  name: string;
}

export function DigiflazzSyncPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: categoriesData } = useQuery({
    queryKey: ["digiflazz-categories"],
    queryFn: () => apiGet<{ categories: Category[] }>("/api/catalog/digiflazz/categories"),
  });
  const categories = categoriesData?.categories ?? [];

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [checkedSkus, setCheckedSkus] = useState<Set<string>>(new Set()); // key: `${brand}::${buyerSkuCode}`
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({}); // key: same as above
  const [importing, setImporting] = useState(false);

  async function runSync() {
    setLoadingPreview(true);
    setPreviewError(null);
    try {
      const res = await apiPost<PreviewResponse>("/api/catalog/digiflazz/sync/preview", {});
      setPreview(res);
      // New brands default to fully checked; existing brands stay unchecked
      // (they're read-only previews here — see the group-level note below).
      const next = new Set<string>();
      for (const g of res.groups) {
        if (g.existingProductId) continue;
        for (const s of g.skus) next.add(`${g.brand}::${s.buyerSkuCode}`);
      }
      setCheckedSkus(next);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to sync from Digiflazz.");
    } finally {
      setLoadingPreview(false);
    }
  }

  function toggleExpanded(brand: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(brand)) n.delete(brand); else n.add(brand);
      return n;
    });
  }

  function toggleSku(key: string) {
    setCheckedSkus((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  function priceFor(key: string, suggested: string): string {
    return priceEdits[key] ?? suggested;
  }

  function priceIsInvalid(key: string, suggested: string): boolean {
    const raw = priceFor(key, suggested);
    const n = Number(raw);
    return !raw || !Number.isFinite(n) || n <= 0;
  }

  async function applyImport() {
    if (!preview || !categoryId) return;
    const newGroups = preview.groups.filter((g) => !g.existingProductId);
    const brands = newGroups
      .map((g) => ({
        brand: g.brand,
        rows: g.skus
          .filter((s) => checkedSkus.has(`${g.brand}::${s.buyerSkuCode}`))
          .map((s) => ({
            buyerSkuCode: s.buyerSkuCode,
            productName: s.productName,
            price: priceFor(`${g.brand}::${s.buyerSkuCode}`, s.suggestedPrice),
          })),
      }))
      .filter((b) => b.rows.length > 0);
    if (brands.length === 0) {
      toast.error("Select at least one SKU to import.");
      return;
    }
    setImporting(true);
    try {
      const res = await apiPost<{ ok: true; brandsImported: number; denominationsImported: number }>(
        "/api/catalog/digiflazz/sync/apply",
        { categoryId: Number(categoryId), brands },
      );
      toast.success(`Imported ${res.brandsImported} game(s), ${res.denominationsImported} denomination(s). Activate them from the Catalog page when ready.`);
      await queryClient.invalidateQueries({ queryKey: ["catalog"] });
      navigate("/catalog");
    } catch (err) {
      toast.error(describeError(err instanceof Error ? err.message : "Import failed."));
    } finally {
      setImporting(false);
    }
  }

  const newGroups = (preview?.groups ?? []).filter(
    (g) => !g.existingProductId && (!filter || g.brand.toLowerCase().includes(filter.toLowerCase())),
  );
  const existingGroups = (preview?.groups ?? []).filter(
    (g) => g.existingProductId && (!filter || g.brand.toLowerCase().includes(filter.toLowerCase())),
  );

  return (
    <PageLayout title="Sync Digiflazz">
      <PageHeader
        title="Sync Digiflazz"
        description="Pull Digiflazz's Game price list, review, and bulk-import new titles into the catalog."
        actions={
          <Button size="sm" onClick={() => void runSync()} disabled={loadingPreview}>
            {loadingPreview ? "Syncing…" : "Sync dari Digiflazz"}
          </Button>
        }
      />

      {previewError && <p className="text-sm text-rust">{previewError}</p>}

      {preview && (
        <div className="flex flex-col gap-4">
          {/* Stacks full-width on mobile, sits side-by-side from `sm` up —
              two fixed-width `max-w-xs` fields side by side on a narrow phone
              viewport (~360px) leaves no room for either to be usable. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Input
              placeholder="Filter by game name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full sm:max-w-xs"
            />
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="w-full sm:max-w-xs">
                <SelectValue placeholder="Target category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {newGroups.map((g) => (
            <Card key={g.brand}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="cursor-pointer" onClick={() => toggleExpanded(g.brand)}>
                  {g.brand} <span className="text-sm text-ink-soft">— {g.skus.length} SKU(s), Baru</span>
                </CardTitle>
              </CardHeader>
              {expanded.has(g.brand) && (
                <CardContent className="space-y-2">
                  {g.skus.map((s) => {
                    const key = `${g.brand}::${s.buyerSkuCode}`;
                    const invalid = priceIsInvalid(key, s.suggestedPrice);
                    return (
                      // Stacks vertically below `sm` (checkbox+name on one
                      // line, cost+price input on the next, both full-width)
                      // — the row's fixed-width pieces (checkbox, cost
                      // label, price input) leave no room for the product
                      // name on a ~360px phone viewport if forced onto one
                      // line, causing exactly the "kelebihan layar" overflow
                      // this component must never produce.
                      <div key={key} className="flex flex-col gap-2 border-b border-line pb-2 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:gap-3">
                        <div className="flex items-center gap-3">
                          <Checkbox checked={checkedSkus.has(key)} onCheckedChange={() => toggleSku(key)} />
                          <span className="flex-1 text-sm sm:hidden">{s.productName}</span>
                        </div>
                        <span className="hidden flex-1 text-sm sm:inline">{s.productName}</span>
                        <div className="flex items-center gap-3 pl-7 sm:pl-0">
                          <span className="shrink-0 text-xs text-ink-soft">Cost {s.costPrice}</span>
                          <Input
                            className={invalid ? "w-full border-rust sm:w-32" : "w-full sm:w-32"}
                            value={priceFor(key, s.suggestedPrice)}
                            onChange={(e) => setPriceEdits((p) => ({ ...p, [key]: e.target.value }))}
                          />
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              )}
            </Card>
          ))}

          {existingGroups.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Sudah ada ({existingGroups.length})</CardTitle></CardHeader>
              <CardContent>
                <p className="text-sm text-ink-soft">
                  These games are already imported — price/status updates happen automatically on the hourly
                  sync, not through this wizard.
                </p>
                <ul className="mt-2 text-sm">
                  {existingGroups.map((g) => (
                    <li key={g.brand}>{g.brand} — {g.skus.length} SKU(s)</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {newGroups.length > 0 && (
            <Button onClick={() => void applyImport()} disabled={importing || !categoryId}>
              {importing ? "Importing…" : "Impor Terpilih"}
            </Button>
          )}
        </div>
      )}
    </PageLayout>
  );
}
