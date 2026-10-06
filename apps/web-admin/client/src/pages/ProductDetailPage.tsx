import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { ImageUploadField } from "../components/shared/ImageUploadField";
import { ButtonLabelInput } from "../components/shared/ButtonLabelInput";
import { StatusBadge } from "../components/shared/StatusBadge";
import { RestockRequestsHeader } from "../components/shared/RestockRequestsHeader";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { AlertCircle, SquarePen, Save, X, Plus, Trash2, Zap, MoreVertical, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { toast } from "sonner";
import { apiGet, apiPost, apiPatch, apiDelete } from "../api/client";
import { useCatalog, CATALOG_QUERY_KEY } from "../api/catalog";
import { describeError } from "../lib/errorMessages";
import { visibleSelection } from "../lib/selection";
import { formatRestockRequests } from "../lib/restockRequests";

interface DenominationRow {
  id: number;
  name: string;
  price: string;
  costPrice: string | null;
  isActive: boolean;
  type: string;
  durationLabel: string;
  /** Compact-button quantity (Task 8/14), e.g. 86 "Diamonds" — null until set. */
  qtyValue: number | null;
  qtyUnit: string | null;
}

interface ProductDetail {
  id: number;
  name: string;
  description: string | null;
  /** Storefront detail blocks (prisma Product) — optional per product. */
  whatYouGet: string | null;
  terms: string | null;
  warrantyNote: string | null;
  isActive: boolean;
  webImageUrl: string | null;
  category: { id: number; name: string; group: string | null } | null;
  denominations: DenominationRow[];
  /** Catalog-presentation classification (Fase 12 task 22) — the default
   * placeholder art style (thumbnailKind) and the currency-icon chip shown
   * on this product's denomination cards (currencyIconKind) on the
   * storefront. Both null until an admin sets them; both hidden entirely
   * from the edit form for a product in a PREMIUM_APPS-group category. */
  thumbnailKind: string | null;
  currencyIconKind: string | null;
  /** Admin-authored game-navigation classification (Task 8/14) — the bot's
   * catalog navigation and denomination labeling (Tasks 11-13) key off
   * these three, null until an admin sets them. */
  gameVariant: string | null;
  gameVariantEmoji: string | null;
  gameRegion: string | null;
}

interface DenomStat {
  belowCost?: boolean;
  id: number;
  available: number;
  waiting: number;
  rule: { minQuantity: number; discountPercent: string } | null;
  flash?: { discountPercent: string; active: boolean } | null;
}

interface ProductDetailData {
  product: ProductDetail;
  statsByDenom: Record<string, DenomStat>;
}

// Sentinel for "automatic/none" on the thumbnailKind/currencyIconKind
// selects below — shadcn's Select rejects an empty-string item value, same
// reasoning as CategoryDialog.tsx's NO_GROUP.
const AUTO_KIND = "auto";

const THUMBNAIL_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "game", label: "Game" },
  { value: "voucher", label: "Voucher" },
  { value: "steam", label: "Steam" },
  { value: "entertainment", label: "Hiburan" },
  { value: "app", label: "Aplikasi" },
  { value: "generic", label: "Umum" },
];

const CURRENCY_ICON_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "diamond", label: "Diamond" },
  { value: "coin", label: "Koin" },
  { value: "key", label: "Key" },
  { value: "card", label: "Kartu" },
  { value: "voucher", label: "Voucher" },
];

function useProductDetail(productId: string) {
  return useQuery<ProductDetailData>({
    queryKey: ["catalog", productId],
    queryFn: async () => apiGet<ProductDetailData>(`/api/catalog/${productId}`),
    enabled: !!productId,
  });
}

export function ProductDetailPage() {
  const { productId } = useParams<{ productId: string }>();
  const navigate = useNavigate();
  const { data, isError, refetch } = useProductDetail(productId ?? "");
  const { data: catalog } = useCatalog();
  const queryClient = useQueryClient();
  const [togglingProduct, setTogglingProduct] = useState<Set<number>>(new Set());
  const [togglingDenom, setTogglingDenom] = useState<Set<number>>(new Set());
  const [editingProduct, setEditingProduct] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  // Game-navigation classification (Task 8/14) — bot navigation and
  // denomination labeling (Tasks 11-13) key off these three. Independent of
  // each other and of every other field on this form.
  const [gameVariantDraft, setGameVariantDraft] = useState("");
  const [gameVariantEmojiDraft, setGameVariantEmojiDraft] = useState("");
  const [gameRegionDraft, setGameRegionDraft] = useState("");
  // Storefront detail blocks — each renders as its own titled section on the
  // product page, and stays hidden there while it's blank.
  const [whatYouGetDraft, setWhatYouGetDraft] = useState("");
  const [termsDraft, setTermsDraft] = useState("");
  const [warrantyNoteDraft, setWarrantyNoteDraft] = useState("");
  const [categoryDraft, setCategoryDraft] = useState<string>("");
  // Catalog-presentation classification (Fase 12 task 22) — AUTO_KIND means
  // "no override set" (null), mapped at the save-payload boundary below.
  const [thumbnailKindDraft, setThumbnailKindDraft] = useState<string>(AUTO_KIND);
  const [currencyIconKindDraft, setCurrencyIconKindDraft] = useState<string>(AUTO_KIND);
  const [savingProduct, setSavingProduct] = useState(false);
  const [productError, setProductError] = useState<string | null>(null);
  const [pendingDeleteDenom, setPendingDeleteDenom] = useState<DenominationRow | null>(null);
  const [selectedDenoms, setSelectedDenoms] = useState<Set<number>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);

  // Clear the selection when navigating to a different product's detail
  // page — a stale selection surviving a productId change would let a bulk
  // action apply to another product's denominations, matching CatalogPage's
  // own filter-change clear.
  useEffect(() => {
    setSelectedDenoms(new Set());
  }, [productId]);

  async function saveProduct() {
    setSavingProduct(true);
    setProductError(null);
    try {
      await apiPatch(`/api/catalog/products/${productId}`, {
        name: nameDraft.trim(),
        description: descriptionDraft.trim(),
        gameVariant: gameVariantDraft.trim(),
        gameVariantEmoji: gameVariantEmojiDraft.trim(),
        gameRegion: gameRegionDraft.trim(),
        whatYouGet: whatYouGetDraft.trim(),
        terms: termsDraft.trim(),
        warrantyNote: warrantyNoteDraft.trim(),
        thumbnailKind: thumbnailKindDraft === AUTO_KIND ? null : thumbnailKindDraft,
        currencyIconKind: currencyIconKindDraft === AUTO_KIND ? null : currencyIconKindDraft,
        ...(categoryDraft ? { categoryId: Number(categoryDraft) } : {}),
      });
      setEditingProduct(false);
      // Prefix match, so this covers both this product's ["catalog", id] query
      // and the shared ["catalog"] list the catalog and categories pages read —
      // a move has to reach the category counts on both.
      await queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
    } catch (e) {
      setProductError(e instanceof Error ? e.message : "Failed to save product.");
    } finally {
      setSavingProduct(false);
    }
  }

  async function toggleProductActive(id: number, active: boolean) {
    setTogglingProduct((s) => new Set([...s, id]));
    try {
      await apiPost(`/api/catalog/products/${id}/active`, { active });
      await queryClient.invalidateQueries({ queryKey: ["catalog", productId] });
    } finally {
      setTogglingProduct((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }

  async function toggleDenominationActive(id: number, active: boolean) {
    setTogglingDenom((s) => new Set([...s, id]));
    try {
      await apiPost(`/api/catalog/denominations/${id}/active`, { active });
      await queryClient.invalidateQueries({ queryKey: ["catalog", productId] });
    } finally {
      setTogglingDenom((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }

  async function deleteDenomination(id: number) {
    try {
      await apiDelete(`/api/catalog/denominations/${id}`);
      await queryClient.invalidateQueries({ queryKey: ["catalog", productId] });
      toast.success("Denomination deleted.");
    } catch (e) {
      toast.error(describeError(e, "Failed to delete denomination."));
    }
  }

  function toggleDenomSelected(id: number) {
    setSelectedDenoms((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  // Takes an explicit `ids` argument rather than reading the derived selection
  // from closure, matching CatalogPage's own bulk handlers — the derived
  // binding is declared past this point, below the early returns.
  async function bulkSetDenomActive(active: boolean, ids: number[]) {
    const count = ids.length;
    setBulkActing(true);
    try {
      await apiPost("/api/catalog/denominations/bulk-active", { ids, active });
      setSelectedDenoms(new Set());
      await queryClient.invalidateQueries({ queryKey: ["catalog", productId] });
      toast.success(`${count} denomination(s) ${active ? "activated" : "deactivated"}.`);
    } catch (e) {
      toast.error(describeError(e, "Failed to update denominations."));
    } finally {
      setBulkActing(false);
    }
  }

  if (isError) {
    return (
      <PageLayout title="Product Detail">
        <EmptyState
          icon={AlertCircle}
          title="Failed to load product"
          description="An error occurred while loading the product details. Please try again."
          action={{
            label: "Retry",
            onClick: () => void refetch(),
          }}
        />
      </PageLayout>
    );
  }
  if (!data) {
    return (
      <PageLayout title="Product Detail">
        <p>Loading…</p>
      </PageLayout>
    );
  }

  const { product, statsByDenom } = data;

  // No client-side filtering of this list, so select-all always spans every
  // denomination on screen — same reasoning as CatalogPage's own comment on
  // its unpaginated list.
  const allDenomsSelected =
    product.denominations.length > 0 && product.denominations.every((d) => selectedDenoms.has(d.id));
  const visibleSelectedDenoms = visibleSelection(selectedDenoms, product.denominations, (d) => d.id);
  function toggleSelectAllDenoms() {
    setSelectedDenoms((prev) => {
      if (allDenomsSelected) return new Set();
      const next = new Set(prev);
      product.denominations.forEach((d) => next.add(d.id));
      return next;
    });
  }

  return (
    <PageLayout title={product.name}>
      <PageHeader
        title={product.name}
        breadcrumb={[{ label: "Catalog", href: "/catalog" }]}
      />

      <Card className="mb-4">
        <CardContent className="flex items-center gap-4 text-sm">
          <span className="text-ink-soft">
            Category:{" "}
            {product.category ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0 align-baseline"
                onClick={() => navigate(`/catalog?categoryId=${product.category!.id}`)}
              >
                {product.category.name}
              </Button>
            ) : (
              <span className="text-ink">—</span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Switch
              checked={product.isActive}
              onCheckedChange={(checked) => void toggleProductActive(product.id, checked)}
              disabled={togglingProduct.has(product.id)}
            />
            <span className="text-ink-soft">{product.isActive ? "Active" : "Inactive"}</span>
          </div>
          {!editingProduct && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setNameDraft(product.name);
                setDescriptionDraft(product.description ?? "");
                setGameVariantDraft(product.gameVariant ?? "");
                setGameVariantEmojiDraft(product.gameVariantEmoji ?? "");
                setGameRegionDraft(product.gameRegion ?? "");
                setWhatYouGetDraft(product.whatYouGet ?? "");
                setTermsDraft(product.terms ?? "");
                setWarrantyNoteDraft(product.warrantyNote ?? "");
                setCategoryDraft(product.category ? String(product.category.id) : "");
                setThumbnailKindDraft(product.thumbnailKind ?? AUTO_KIND);
                setCurrencyIconKindDraft(product.currencyIconKind ?? AUTO_KIND);
                setEditingProduct(true);
              }}
            >
              <SquarePen className="h-4 w-4" />
              Edit product
            </Button>
          )}
        </CardContent>
      </Card>

      {editingProduct && (
        <Card className="mb-4 max-w-lg">
          <CardContent className="flex flex-col gap-3">
            <div>
              <label className="text-sm font-medium text-ink" id="product-category-label">Category</label>
              <Select value={categoryDraft} onValueChange={setCategoryDraft}>
                <SelectTrigger className="mt-1" aria-labelledby="product-category-label">
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
                <SelectContent>
                  {(catalog?.categories ?? []).map((cat) => (
                    <SelectItem key={cat.id} value={String(cat.id)}>
                      {cat.emoji ? `${cat.emoji} ` : ""}
                      {cat.name}
                      {cat.isActive ? "" : " (inactive)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium text-ink">Name</label>
              <ButtonLabelInput kind="productList" className="mt-1" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium text-ink">Description</label>
              <Textarea className="mt-1" rows={3} value={descriptionDraft} onChange={(e) => setDescriptionDraft(e.target.value)} />
            </div>
            {/* Catalog-presentation classification (Fase 12 task 22) —
                optional; hidden entirely (not disabled) for a product whose
                category is in the PREMIUM_APPS group, which uses its own
                presentation instead. */}
            {product.category?.group !== "PREMIUM_APPS" && (
              <>
                <div>
                  <label className="text-sm font-medium text-ink" id="product-thumbnail-kind-label">
                    Gaya thumbnail default
                  </label>
                  <Select value={thumbnailKindDraft} onValueChange={setThumbnailKindDraft}>
                    <SelectTrigger className="mt-1" aria-labelledby="product-thumbnail-kind-label">
                      <SelectValue placeholder="Otomatis" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTO_KIND}>Otomatis</SelectItem>
                      {THUMBNAIL_KIND_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium text-ink" id="product-currency-icon-kind-label">
                    Ikon currency
                  </label>
                  <Select value={currencyIconKindDraft} onValueChange={setCurrencyIconKindDraft}>
                    <SelectTrigger className="mt-1" aria-labelledby="product-currency-icon-kind-label">
                      <SelectValue placeholder="Otomatis" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTO_KIND}>Otomatis</SelectItem>
                      {CURRENCY_ICON_KIND_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            {/* Game-navigation classification (Task 8/14) — optional, powers
                the bot's catalog navigation and denomination labeling for
                game top-up products (e.g. Mobile Legends' Diamonds variant). */}
            <div>
              <label className="text-sm font-medium text-ink">Game Variant</label>
              <ButtonLabelInput
                kind="gameVariant"
                emoji={gameVariantEmojiDraft.trim() !== ""}
                className="mt-1"
                placeholder="e.g. Diamonds"
                value={gameVariantDraft}
                onChange={(e) => setGameVariantDraft(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-ink">Game Variant Emoji</label>
              <Input
                className="mt-1 w-24"
                placeholder="e.g. 💎"
                value={gameVariantEmojiDraft}
                onChange={(e) => setGameVariantEmojiDraft(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-ink">Game Region</label>
              <ButtonLabelInput
                kind="gameRegion"
                className="mt-1"
                placeholder="e.g. Global"
                value={gameRegionDraft}
                onChange={(e) => setGameRegionDraft(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-ink">What the buyer gets</label>
              <Textarea
                className="mt-1"
                rows={3}
                placeholder="Private account, 1 device&#10;Can change the profile name&#10;Active for 30 days"
                value={whatYouGetDraft}
                onChange={(e) => setWhatYouGetDraft(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-ink">Terms of use</label>
              <Textarea
                className="mt-1"
                rows={2}
                placeholder="Don't change the account email or password — it voids the warranty."
                value={termsDraft}
                onChange={(e) => setTermsDraft(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-ink">Warranty</label>
              <Textarea
                className="mt-1"
                rows={2}
                placeholder="Full 30-day warranty, claimed through a support ticket."
                value={warrantyNoteDraft}
                onChange={(e) => setWarrantyNoteDraft(e.target.value)}
              />
            </div>
            {productError && <p className="text-sm text-rust">{productError}</p>}
            <div className="flex gap-2">
              <Button size="sm" disabled={!nameDraft.trim() || savingProduct} onClick={() => void saveProduct()}>
                <Save className="h-4 w-4" />
                {savingProduct ? "Saving…" : "Save"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditingProduct(false); setProductError(null); }}>
                <X className="h-4 w-4" />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mb-4 max-w-sm">
        <ImageUploadField
          label="Product photo"
          imageUrl={product.webImageUrl ?? ""}
          uploadPath={`/catalog/product/${productId}/photo`}
          fieldName="photo"
          accept=".jpg,.jpeg,.png,.webp"
          dimensions="800x600px"
          maxBytes={5 * 1024 * 1024}
          onUploaded={(url) =>
            queryClient.setQueryData<ProductDetailData>(["catalog", productId], (old) =>
              old ? { ...old, product: { ...old.product, webImageUrl: url } } : old,
            )
          }
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle as="h2">Denominations ({product.denominations.length})</CardTitle>
          <Button size="sm" onClick={() => navigate(`/catalog/${productId}/denominations/new`)}>
            <Plus className="h-4 w-4" />
            Add Denomination
          </Button>
        </CardHeader>
        <CardContent>
          {visibleSelectedDenoms.size > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-sand px-3 py-2 text-sm">
              <span className="text-ink-soft">{visibleSelectedDenoms.size} selected</span>
              <Button
                size="sm"
                variant="outline"
                disabled={bulkActing}
                onClick={() => void bulkSetDenomActive(true, Array.from(visibleSelectedDenoms))}
              >
                <Check className="h-4 w-4" />
                Activate
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bulkActing}
                onClick={() => void bulkSetDenomActive(false, Array.from(visibleSelectedDenoms))}
              >
                <X className="h-4 w-4" />
                Deactivate
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedDenoms(new Set())}>
                Clear
              </Button>
            </div>
          )}

          <DataTable
            nested
            columns={[
              {
                key: "select",
                kind: "selection",
                header: (
                  <Checkbox
                    checked={allDenomsSelected}
                    onCheckedChange={toggleSelectAllDenoms}
                    disabled={product.denominations.length === 0}
                    aria-label="Select all denominations"
                  />
                ),
                render: d => (
                  <Checkbox
                    checked={selectedDenoms.has(d.id)}
                    onCheckedChange={() => toggleDenomSelected(d.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${d.name}`}
                  />
                ),
              },
              {
                key: "name",
                header: "Name",
                render: d => {
                  // ⚡ marks a flash sale that is live *right now* (the API decides
                  // that from the window), so the row shows the price buyers are
                  // actually being charged rather than the column's base price.
                  const flash = statsByDenom[String(d.id)]?.flash;
                  return (
                    <span
                      className={`flex max-w-[240px] items-center text-sm ${!d.isActive ? "text-ink-faint" : "text-ink"}`}
                    >
                      <span className="truncate" title={d.name}>
                        {d.name}
                      </span>
                      {statsByDenom[String(d.id)]?.belowCost && (
                        <span className="ml-1.5 shrink-0"><StatusBadge status="BELOW_COST" /></span>
                      )}
                      {flash?.active && (
                        <span
                          className="ml-1.5 inline-flex shrink-0 items-center align-middle"
                          title={`Flash sale live: ${flash.discountPercent}% off`}
                        >
                          <Zap className="h-4 w-4 text-amberx" />
                        </span>
                      )}
                    </span>
                  );
                },
              },
              { key: "type", header: "Type", render: d => <StatusBadge status={d.type} /> },
              { key: "duration", header: "Duration", render: d => <span className="text-sm text-ink-soft">{d.durationLabel}</span> },
              { key: "price", header: "Price", render: d => <span className="font-mono text-sm">{d.price}</span> },
              {
                key: "stock",
                header: "Stock",
                // "—" (not a fake 0) when the server sent no stat for this
                // denomination at all — a genuine 0 (a manual SKU, or an
                // auto one that has simply sold out) still renders as 0.
                render: d => { const stat = statsByDenom[String(d.id)]; return <span className="text-sm">{stat ? stat.available : "—"}</span>; },
              },
              { key: "waiting", header: <RestockRequestsHeader />, render: d => { const stat = statsByDenom[String(d.id)]; return <span className="text-sm text-ink-soft">{formatRestockRequests(stat?.waiting, stat?.available)}</span>; } },
              {
                key: "active",
                header: "Active",
                render: d => (
                  <Switch
                    checked={d.isActive}
                    onCheckedChange={(checked) => void toggleDenominationActive(d.id, checked)}
                    disabled={togglingDenom.has(d.id)}
                  />
                ),
              },
              {
                key: "actions",
                header: "",
                render: d => (
                  <div onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${d.name}`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => navigate(`/catalog/${productId}/denominations/${d.id}/edit`)}>
                          <SquarePen className="h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={(e) => { e.preventDefault(); setPendingDeleteDenom(d); }}
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
            data={product.denominations}
            keyExtractor={d => d.id}
            empty={<EmptyState title="No denominations" description="Add a denomination to start selling this product." />}
          />
        </CardContent>
      </Card>

      {pendingDeleteDenom && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setPendingDeleteDenom(null); }}
          title="Delete this denomination?"
          description={`Delete "${pendingDeleteDenom.name}". This is refused if it has order history.`}
          confirmLabel="Delete"
          onConfirm={() => deleteDenomination(pendingDeleteDenom.id)}
        />
      )}
    </PageLayout>
  );
}
