import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { toast } from "sonner";
import { apiPost, apiGet } from "../api/client";
import { describeError } from "../lib/errorMessages";
import { useDigiflazzSyncStatus } from "../hooks/useDigiflazzSyncStatus";
import { formatRelativeTime } from "../lib/relativeTime";
import { exactFieldsOf } from "../lib/exactFields";

interface SkuRow {
  buyerSkuCode: string;
  productName: string;
  costPrice: string;
  suggestedPrice: string;
}
interface BrandGroup {
  brand: string;
  rawBrand: string;
  region: string | null;
  gameVariant: string | null;
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

const PREVIEW_STORAGE_KEY = "digiflazz-sync-preview";

/** Counts from POST /api/catalog/digiflazz/sync/run — the full catalog sync. */
interface SyncRunResponse {
  ok: true;
  updated: number;
  deactivated: number;
  added: number;
  reactivated: number;
  /** True when the circuit breaker stopped the run before it wrote anything. */
  aborted?: boolean;
  abortReason?: "sharp_change" | "no_usable_rows";
}

/** Shown when the server reports the run as aborted by the circuit breaker. */
const SYNC_ABORTED_MESSAGE =
  "Sync dibatalkan karena respons Digiflazz tidak wajar; tidak ada yang diubah. Cek koneksi Digiflazz.";

/** The server's exact /sync/run (and /sync/preview) answer when Digiflazz has
 * no credentials — the preview would only repeat it, so it is skipped. */
const NO_CREDENTIALS_ERROR = "Digiflazz credentials are not configured. Set them in Settings first.";
/** The server's exact /sync/run (and /sync/preview) answer when Digiflazz
 * refuses the price-list check with rc 83 — a preview right after it would
 * only be refused again, so it is skipped too. */
const RATE_LIMITED_ERROR = "Digiflazz sedang membatasi pengecekan price-list (rc 83). Coba lagi beberapa menit lagi.";

/** "13 SKU baru ditambahkan, 1 dinonaktifkan, 5 harga diperbarui" — zero
 * parts left out; "Tidak ada perubahan" when nothing changed. New SKUs are
 * live only when their game is on sale, so no "(aktif)" claim here. */
function describeSyncRun(r: SyncRunResponse): string {
  const parts = [
    r.added > 0 ? `${r.added} SKU baru ditambahkan` : null,
    r.reactivated > 0 ? `${r.reactivated} diaktifkan lagi` : null,
    r.deactivated > 0 ? `${r.deactivated} dinonaktifkan` : null,
    r.updated > 0 ? `${r.updated} harga diperbarui` : null,
  ].filter((p): p is string => p !== null);
  return `Sync selesai: ${parts.length > 0 ? parts.join(", ") : "Tidak ada perubahan"}.`;
}

interface PersistedSyncState {
  preview: PreviewResponse | null;
  categoryId: string;
  filter: string;
}

// Restores a prior sync preview from sessionStorage so navigating away and
// back (or refreshing) within the same tab session doesn't force a slow
// re-fetch from Digiflazz's live price-list API. Falls back to the current
// defaults on a missing or corrupted value — a corrupted key must never
// throw and break the page.
function readPersistedState(): PersistedSyncState {
  try {
    const raw = sessionStorage.getItem(PREVIEW_STORAGE_KEY);
    if (!raw) return { preview: null, categoryId: "", filter: "" };
    const parsed = JSON.parse(raw) as Partial<PersistedSyncState>;
    return {
      preview: parsed.preview ?? null,
      categoryId: parsed.categoryId ?? "",
      filter: parsed.filter ?? "",
    };
  } catch {
    return { preview: null, categoryId: "", filter: "" };
  }
}

// New brands default to fully checked; existing brands stay unchecked
// (they're read-only previews here — see the group-level note below). Shared
// by runSync's fresh-fetch path and the sessionStorage-restore path on mount
// so the two derivations never drift apart.
function defaultCheckedSkus(groups: BrandGroup[]): Set<string> {
  const next = new Set<string>();
  for (const g of groups) {
    if (g.existingProductId) continue;
    for (const s of g.skus) next.add(`${g.brand}::${s.buyerSkuCode}`);
  }
  return next;
}

interface DetectionMetrics {
  detectorStamp: string;
  totalRecords: number;
  resolved: number;
  ambiguous: number;
  unknown: number;
  confidenceBuckets: Record<string, number>;
  overrideHits: number;
  finishedAt: string;
}
interface DetectionIssue {
  id: number;
  status: string;
  reviewStatus: string;
  reason: string;
  rawInput: string;
  occurrences: number;
  lastSeenAt: string;
}

/**
 * "Deteksi" panel — the admin-facing view over the Detection Engine's
 * last full-catalog run (Task 9, AC-16/AC-20): a one-line summary of the
 * run plus the queue of OPEN `DetectionIssue` rows, each with a
 * Resolve/Dismiss action. Reads `GET /api/catalog/detection/metrics` and
 * `.../issues`; the actions POST to `.../issues/:id/resolve` and
 * `.../dismiss` and then refetch both queries.
 */
function DetectionPanel() {
  const queryClient = useQueryClient();
  const metricsQuery = useQuery({
    queryKey: ["detection-metrics"],
    queryFn: () => apiGet<{ metrics: DetectionMetrics | null }>("/api/catalog/detection/metrics"),
  });
  const issuesQuery = useQuery({
    queryKey: ["detection-issues", "OPEN"],
    queryFn: () =>
      apiGet<{ issues: DetectionIssue[] }>("/api/catalog/detection/issues?reviewStatus=OPEN"),
  });
  const [busyId, setBusyId] = useState<number | null>(null);

  async function review(id: number, action: "resolve" | "dismiss") {
    setBusyId(id);
    try {
      await apiPost(`/api/catalog/detection/issues/${id}/${action}`, {});
      toast.success(action === "resolve" ? "Isu deteksi ditandai selesai." : "Isu deteksi diabaikan.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["detection-issues"] }),
        queryClient.invalidateQueries({ queryKey: ["detection-metrics"] }),
      ]);
    } catch (err) {
      toast.error(describeError(err, "Gagal memperbarui isu deteksi."));
    } finally {
      setBusyId(null);
    }
  }

  const metrics = metricsQuery.data?.metrics ?? null;
  const issues = issuesQuery.data?.issues ?? [];

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Deteksi</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {metricsQuery.isLoading && <p className="text-sm text-ink-soft">Memuat ringkasan deteksi…</p>}
        {!metricsQuery.isLoading && !metrics && (
          <p className="text-sm text-ink-soft">Deteksi katalog belum pernah dijalankan.</p>
        )}
        {metrics && (
          <div className="space-y-1 text-sm">
            <p className="text-ink">
              {metrics.resolved} cocok, {metrics.ambiguous} ambigu, {metrics.unknown} tidak dikenali dari{" "}
              {metrics.totalRecords} produk.
            </p>
            <p className="text-ink-soft">
              Distribusi keyakinan:{" "}
              {Object.entries(metrics.confidenceBuckets)
                .map(([band, n]) => `${band} → ${n}`)
                .join(" · ")}
            </p>
            <p className="text-ink-soft">
              {metrics.overrideHits} lewat override manual · terakhir dijalankan{" "}
              {formatRelativeTime(metrics.finishedAt, metrics.finishedAt)}
            </p>
          </div>
        )}

        <div>
          <p className="mb-2 text-sm font-medium text-ink">Antrean tinjauan ({issues.length})</p>
          {issuesQuery.isLoading && <p className="text-sm text-ink-soft">Memuat isu deteksi…</p>}
          {!issuesQuery.isLoading && issues.length === 0 && (
            <p className="text-sm text-ink-soft">Tidak ada isu deteksi yang perlu ditinjau.</p>
          )}
          <ul className="space-y-2">
            {issues.map((issue) => (
              <li
                key={issue.id}
                className="flex flex-col gap-2 border-b border-line pb-2 last:border-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
              >
                <div className="min-w-0 text-sm">
                  <p className="text-ink">
                    <span className="text-ink-soft uppercase">{issue.status}</span> — {issue.reason}
                  </p>
                  <p className="truncate text-xs text-ink-soft">
                    {issue.rawInput}
                    {issue.occurrences > 1 ? ` · ${issue.occurrences}×` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === issue.id}
                    onClick={() => void review(issue.id, "resolve")}
                  >
                    Resolve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === issue.id}
                    onClick={() => void review(issue.id, "dismiss")}
                  >
                    Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

export function DigiflazzSyncPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const syncStatus = useDigiflazzSyncStatus();
  const { data: categoriesData } = useQuery({
    queryKey: ["digiflazz-categories"],
    queryFn: () => apiGet<{ categories: Category[] }>("/api/catalog/digiflazz/categories"),
  });
  const categories = categoriesData?.categories ?? [];

  const [preview, setPreview] = useState<PreviewResponse | null>(() => readPersistedState().preview);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string>(() => readPersistedState().categoryId);
  const [filter, setFilter] = useState(() => readPersistedState().filter);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // key: `${brand}::${buyerSkuCode}`. Not persisted, but on a restored preview
  // it's re-derived (not just reset to empty) so a remount doesn't silently
  // uncheck every new brand's SKUs.
  const [checkedSkus, setCheckedSkus] = useState<Set<string>>(() =>
    defaultCheckedSkus(readPersistedState().preview?.groups ?? []),
  );
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({}); // key: same as above
  const [importing, setImporting] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [runSummary, setRunSummary] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Persist the preview (plus the category/filter picked alongside it) so
  // refreshing or navigating away and back within the same tab restores it
  // instead of re-hitting Digiflazz's live price-list API. A fresh mount with
  // no prior sync (preview === null) must never leave a stale key behind.
  // Depends on categoryId/filter too (not just preview) so a category or
  // filter change made after the preview has already loaded is actually
  // saved — those controls only render inside `{preview && ...}`, so without
  // this the persisted values would always be whatever they were the moment
  // `preview` last changed.
  //
  // Wrapped in try/catch, mirroring readPersistedState's read guard (and
  // SettingsNav.tsx's writeExpandedStorage): private-browsing modes in
  // Safari/Firefox, or "block site data" settings, throw on any
  // sessionStorage access, and a full Digiflazz price list can serialize to
  // roughly 1MB, making QuotaExceededError realistic too. A failed persist
  // is not user-facing-error-worthy — it just means the next visit won't
  // have the restored state — so this silently no-ops rather than crashing
  // the page or surfacing a toast.
  useEffect(() => {
    try {
      if (preview === null) {
        sessionStorage.removeItem(PREVIEW_STORAGE_KEY);
        return;
      }
      sessionStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify({ preview, categoryId, filter }));
    } catch {
      // Ignore — nothing to persist to in this environment.
    }
  }, [preview, categoryId, filter]);

  // Runs the full catalog sync first (prices, new SKUs on existing games added
  // active, reactivations, deactivations — the same run as the hourly job),
  // then loads the preview of brand-new games for the import wizard below.
  // A failed run (busy, Digiflazz down) is shown but the preview still loads,
  // except when credentials are missing or Digiflazz is rate-limiting (rc 83) —
  // the preview would fail the same way.
  async function runSync() {
    setLoadingPreview(true);
    setPreviewError(null);
    setRunSummary(null);
    setRunError(null);
    const startedAt = Date.now();
    setElapsedMs(0);
    const elapsedInterval = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    try {
      try {
        const run = await apiPost<SyncRunResponse>("/api/catalog/digiflazz/sync/run", {});
        if (run.aborted) {
          setRunError(SYNC_ABORTED_MESSAGE);
        } else {
          setRunSummary(describeSyncRun(run));
          void queryClient.invalidateQueries({ queryKey: ["catalog"] });
        }
      } catch (err) {
        const message = describeError(err, "Sync dari Digiflazz gagal.");
        setRunError(message);
        if (err instanceof Error && (err.message === NO_CREDENTIALS_ERROR || err.message === RATE_LIMITED_ERROR)) return;
      }
      const res = await apiPost<PreviewResponse>("/api/catalog/digiflazz/sync/preview", {});
      setPreview(res);
      setCheckedSkus(defaultCheckedSkus(res.groups));
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to sync from Digiflazz.");
    } finally {
      clearInterval(elapsedInterval);
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

  // The server reads a retyped price BY SHAPE (16.500 = sixteen and a half
  // thousand, 16.500,50 adds fifty sen) — `Number(raw)` would misjudge both,
  // so only the characters and a non-zero digit are checked here; the server
  // reads the amount and refuses an ambiguous shape.
  function priceIsInvalid(key: string, suggested: string): boolean {
    const raw = priceFor(key, suggested).trim();
    return !/^\d[\d.,]*$/.test(raw) || !/[1-9]/.test(raw);
  }

  // Filter-aware "new" (not yet imported) and "existing" brand-group lists —
  // the exact set of brand cards rendered below. C1 fix: applyImport (further
  // below) MUST reuse this same list, not build its own unfiltered one, or an
  // admin who filters the screen down to one brand and clicks Import ends up
  // importing every other new brand in the whole price list too.
  const newGroups = (preview?.groups ?? []).filter(
    (g) => !g.existingProductId && (!filter || g.brand.toLowerCase().includes(filter.toLowerCase())),
  );
  const existingGroups = (preview?.groups ?? []).filter(
    (g) => g.existingProductId && (!filter || g.brand.toLowerCase().includes(filter.toLowerCase())),
  );

  // I10: block submission when a checked row that would actually be
  // submitted (i.e. visible under the current filter) has an invalid price —
  // the backend rejects the WHOLE multi-brand request on any single bad row,
  // so silently dropping it instead of blocking would be more surprising.
  const hasInvalidCheckedPrice = newGroups.some((g) =>
    g.skus.some((s) => {
      const key = `${g.brand}::${s.buyerSkuCode}`;
      return checkedSkus.has(key) && priceIsInvalid(key, s.suggestedPrice);
    }),
  );

  async function applyImport() {
    if (!preview || !categoryId) return;
    const brands = newGroups
      .map((g) => ({
        brand: g.brand,
        gameVariant: g.gameVariant,
        rows: g.skus
          .filter((s) => checkedSkus.has(`${g.brand}::${s.buyerSkuCode}`))
          .map((s) => ({
            buyerSkuCode: s.buyerSkuCode,
            productName: s.productName,
            price: priceFor(`${g.brand}::${s.buyerSkuCode}`, s.suggestedPrice),
            // An untouched suggestion is the server's own plain decimal, read
            // exactly; a retyped price is read by shape (lib/exactFields.ts).
            exact_fields: exactFieldsOf(
              { price: priceFor(`${g.brand}::${s.buyerSkuCode}`, s.suggestedPrice) },
              { price: s.suggestedPrice },
              ["price"],
            ),
            // I11 fix: forward the cost price the preview already computed —
            // without this, a freshly-imported denomination had no costPrice
            // at all until the first resync tick filled it in.
            costPrice: s.costPrice,
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
      // Imperative here (not left to the persisting effect above) because
      // this function never calls setPreview(null) before navigating away —
      // it jumps straight to /catalog, so the effect never gets a chance to
      // re-run and remove the key itself. Guarded the same way as the
      // effect: a failed removal here is not user-facing-error-worthy.
      try {
        sessionStorage.removeItem(PREVIEW_STORAGE_KEY);
      } catch {
        // Ignore — nothing to clear in this environment.
      }
      await queryClient.invalidateQueries({ queryKey: ["catalog"] });
      navigate("/catalog");
    } catch (err) {
      toast.error(describeError(err, "Import failed."));
    } finally {
      setImporting(false);
    }
  }

  return (
    <PageLayout title="Sync Digiflazz">
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Hourly Sync Status</CardTitle>
        </CardHeader>
        <CardContent>
          {syncStatus.data === undefined && (
            <p className="text-sm text-ink-soft">Loading sync status…</p>
          )}
          {syncStatus.data === null && (
            <p className="text-sm text-ink-soft">
              This shop's catalog has never been auto-synced yet — the hourly sync will run automatically.
            </p>
          )}
          {syncStatus.data && syncStatus.data.status === "success" && (
            <p className="text-sm text-ink">
              Last synced {formatRelativeTime(syncStatus.data.finishedAt, syncStatus.data.finishedAt)} —{" "}
              {syncStatus.data.updated} price(s) updated, {syncStatus.data.added} new SKU(s) added,{" "}
              {syncStatus.data.reactivated} reactivated, {syncStatus.data.deactivated} deactivated.
            </p>
          )}
          {syncStatus.data && syncStatus.data.status === "aborted" && (
            <p className="text-sm text-rust">
              {syncStatus.data.abortReason === "sharp_change"
                ? "Aborted: too many prices moved sharply — this usually means the supplier's response was malformed, not a real market-wide price change."
                : "Aborted: the supplier returned no usable price data."}{" "}
              ({formatRelativeTime(syncStatus.data.finishedAt, syncStatus.data.finishedAt)})
            </p>
          )}
          {syncStatus.data && syncStatus.data.status === "error" && (
            <p className="text-sm text-rust">
              The last sync attempt failed. ({formatRelativeTime(syncStatus.data.finishedAt, syncStatus.data.finishedAt)})
            </p>
          )}
        </CardContent>
      </Card>

      <DetectionPanel />

      <PageHeader
        title="Sync Digiflazz"
        description="Pull Digiflazz's Game price list, review, and bulk-import new titles into the catalog."
        actions={
          <Button size="sm" onClick={() => void runSync()} disabled={loadingPreview}>
            {loadingPreview ? `Syncing… ${Math.floor(elapsedMs / 1000)}s` : "Sync dari Digiflazz"}
          </Button>
        }
      />

      {runSummary && <p className="mb-2 text-sm text-ink">{runSummary}</p>}
      {runError && <p className="mb-2 text-sm text-rust">{runError}</p>}
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
                <CardTitle>
                  <button
                    type="button"
                    className="w-full cursor-pointer p-0 text-left"
                    aria-expanded={expanded.has(g.brand)}
                    onClick={() => toggleExpanded(g.brand)}
                  >
                    {g.rawBrand}{g.region ? <span className="text-ink-soft"> ({g.region})</span> : null}
                    {g.gameVariant ? (
                      <Badge variant="secondary" className="ml-1 bg-sand text-ink-soft">
                        {g.gameVariant}
                      </Badge>
                    ) : null}{" "}
                    <span className="text-sm text-ink-soft">— {g.skus.length} SKU(s), Baru</span>
                  </button>
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
                          <span className="shrink-0 text-xs text-ink-soft">Cost {s.costPrice} (IDR)</span>
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
                  Game ini sudah diimpor dan diperbarui otomatis setiap jam dan saat Anda menekan Sync: harga
                  ikut diperbarui, SKU baru langsung ditambahkan (aktif bila game sedang dijual), dan SKU yang tidak tersedia dinonaktifkan.
                </p>
                <ul className="mt-2 text-sm">
                  {existingGroups.map((g) => (
                    <li key={g.brand}>
                      {g.rawBrand}{g.region ? <span className="text-ink-soft"> ({g.region})</span> : null}
                      {g.gameVariant ? (
                        <Badge variant="secondary" className="ml-1 bg-sand text-ink-soft">
                          {g.gameVariant}
                        </Badge>
                      ) : null} — {g.skus.length} SKU(s)
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {newGroups.length > 0 && (
            <div className="flex flex-col items-start gap-1">
              <Button onClick={() => void applyImport()} disabled={importing || !categoryId || hasInvalidCheckedPrice}>
                {importing ? "Importing…" : "Impor Terpilih"}
              </Button>
              {hasInvalidCheckedPrice && (
                <p className="text-sm text-rust">Fix the highlighted price(s) before importing.</p>
              )}
            </div>
          )}
        </div>
      )}
    </PageLayout>
  );
}
