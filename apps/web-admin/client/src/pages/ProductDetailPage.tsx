import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, MoreVertical, Plus, Save, SquarePen, Trash2, X, Zap } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { CATALOG_QUERY_KEY, useCatalog } from "../api/catalog";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api/client";
import { PricingMargin, PricingSourceBadge, type CatalogPricingInfo } from "../components/catalog/PricingSummary";
import { ButtonLabelInput } from "../components/shared/ButtonLabelInput";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount.helpers";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ImageUploadField } from "../components/shared/ImageUploadField";
import { PageHeader } from "../components/shared/PageHeader";
import { PageLayout } from "../components/shared/PageLayout";
import { RestockRequestsHeader } from "../components/shared/RestockRequestsHeader";
import { StatusBadge } from "../components/shared/StatusBadge";
import { describeError } from "../lib/errorMessages";
import { formatRestockRequests } from "../lib/restockRequests";
import { visibleSelection } from "../lib/selection";

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
  supplierSku?: string | null;
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
  pricing?: CatalogPricingInfo;
  belowCost?: boolean;
  id: number;
  available: number;
  /** Where the SKU is fulfilled from (resolved by the server). Only
   *  INTERNAL_INVENTORY draws from local stock, so only it has a stock count. */
  fulfillmentSource?: "INTERNAL_INVENTORY" | "PROVIDER_API" | "MANUAL";
  usesLocalInventory?: boolean;
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
  const fieldId = useId();
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
  const actionInFlight = useRef(false);
  const [pendingBulkDelete, setPendingBulkDelete] = useState<number[] | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const deletedQuery = useQuery<{ denominations: { id: number; name: string }[] }>({
    queryKey: ["catalog", productId, "deleted"],
    queryFn: () => apiGet(`/api/catalog/products/${productId}/denominations/deleted`),
    enabled: showDeleted && !!productId,
  });

  async function archiveSelected(ids: number[], restore = false) {
    if (actionInFlight.current || !ids.length) return;
    actionInFlight.current = true;
    setBulkActing(true);
    try {
      const result = await apiPost<{ count: number }>(`/api/catalog/products/${productId}/denominations/${restore ? "bulk-restore" : "bulk-delete"}`, { ids });
      setSelectedDenoms(new Set());
      await queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
      toast.success(`${result.count} denomination(s) ${restore ? "restored inactive" : "deleted"}.`);
    } catch (e) {
      toast.error(describeError(e, "Failed to update denominations. Nothing was changed."));
    } finally {
      actionInFlight.current = false;
      setBulkActing(false);
    }
  }

  // Clear the selection when navigating to a different product's detail
  // page — a stale selection surviving a productId change would let a bulk
  // action apply to another product's denominations, matching CatalogPage's
  // own filter-change clear.
  useEffect(() => {
    setSelectedDenoms(new Set());
    setPendingBulkDelete(null);
    setShowDeleted(false);
  }, [productId]);

  const selectedCategory = catalog?.categories?.find((c) => String(c.id) === categoryDraft);
  const isGame = (selectedCategory ?? data?.product.category)?.group === "GAME_TOPUP";

  const { saveProduct } = useProductEditorSave({ setSavingProduct, setProductError, productId, nameDraft, descriptionDraft, isGame, gameVariantDraft, data, gameVariantEmojiDraft, gameRegionDraft, whatYouGetDraft, termsDraft, warrantyNoteDraft, thumbnailKindDraft, currencyIconKindDraft, categoryDraft, setEditingProduct, queryClient });

  const { toggleProductActive, toggleDenominationActive, deleteDenomination } = useProductStateActions({ setTogglingProduct, queryClient, productId, setTogglingDenom });

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
    if (actionInFlight.current) return;
    actionInFlight.current = true;
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
      actionInFlight.current = false;
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

      <ProductDetailSummary product={product} navigate={navigate} toggleProductActive={toggleProductActive} togglingProduct={togglingProduct} editingProduct={editingProduct} setNameDraft={setNameDraft} setDescriptionDraft={setDescriptionDraft} setGameVariantDraft={setGameVariantDraft} setGameVariantEmojiDraft={setGameVariantEmojiDraft} setGameRegionDraft={setGameRegionDraft} setWhatYouGetDraft={setWhatYouGetDraft} setTermsDraft={setTermsDraft} setWarrantyNoteDraft={setWarrantyNoteDraft} setCategoryDraft={setCategoryDraft} setThumbnailKindDraft={setThumbnailKindDraft} setCurrencyIconKindDraft={setCurrencyIconKindDraft} setEditingProduct={setEditingProduct} />

      {editingProduct && (
        <Card className="mb-4 max-w-lg">
          <CardContent className="flex flex-col gap-3">
            <ProductCategoryField fieldId={fieldId} categoryDraft={categoryDraft} setCategoryDraft={setCategoryDraft} catalog={catalog} />
            <div>
              <label htmlFor={`${fieldId}-name-2`} className="text-sm font-medium text-ink">Name</label>
              <ButtonLabelInput id={`${fieldId}-name-2`} kind="productList" className="mt-1" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
            </div>
            <div>
              <label htmlFor={`${fieldId}-description-3`} className="text-sm font-medium text-ink">Description</label>
              <Textarea id={`${fieldId}-description-3`} className="mt-1" rows={3} value={descriptionDraft} onChange={(e) => setDescriptionDraft(e.target.value)} />
            </div>
            {/* Catalog-presentation classification (Fase 12 task 22) —
                optional; only relevant for a Game Top Up category. */}
            <ProductGamePresentationFields isGame={isGame} fieldId={fieldId} thumbnailKindDraft={thumbnailKindDraft} setThumbnailKindDraft={setThumbnailKindDraft} currencyIconKindDraft={currencyIconKindDraft} setCurrencyIconKindDraft={setCurrencyIconKindDraft} />
            <ProductGameFields isGame={isGame} fieldId={fieldId} gameVariantEmojiDraft={gameVariantEmojiDraft} gameVariantDraft={gameVariantDraft} setGameVariantDraft={setGameVariantDraft} setGameVariantEmojiDraft={setGameVariantEmojiDraft} gameRegionDraft={gameRegionDraft} setGameRegionDraft={setGameRegionDraft} />

            <div>
              <label htmlFor={`${fieldId}-what-the-buyer-gets-9`} className="text-sm font-medium text-ink">What the buyer gets</label>
              <Textarea id={`${fieldId}-what-the-buyer-gets-9`}
                className="mt-1"
                rows={3}
                placeholder="Private account, 1 device&#10;Can change the profile name&#10;Active for 30 days"
                value={whatYouGetDraft}
                onChange={(e) => setWhatYouGetDraft(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${fieldId}-terms-of-use-10`} className="text-sm font-medium text-ink">Terms of use</label>
              <Textarea id={`${fieldId}-terms-of-use-10`}
                className="mt-1"
                rows={2}
                placeholder="Don't change the account email or password — it voids the warranty."
                value={termsDraft}
                onChange={(e) => setTermsDraft(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${fieldId}-warranty-11`} className="text-sm font-medium text-ink">Warranty</label>
              <Textarea id={`${fieldId}-warranty-11`}
                className="mt-1"
                rows={2}
                placeholder="Full 30-day warranty, claimed through a support ticket."
                value={warrantyNoteDraft}
                onChange={(e) => setWarrantyNoteDraft(e.target.value)}
              />
            </div>
            {productError && <p className="text-sm text-rust">{productError}</p>}
            <ProductEditorActions nameDraft={nameDraft} savingProduct={savingProduct} saveProduct={saveProduct} setEditingProduct={setEditingProduct} setProductError={setProductError} />
          </CardContent>
        </Card>
      )}

      <ProductPhotoField product={product} productId={productId} queryClient={queryClient} />

      <ProductDenominationsSection product={product} navigate={navigate} productId={productId} visibleSelectedDenoms={visibleSelectedDenoms} bulkActing={bulkActing} bulkSetDenomActive={bulkSetDenomActive} setPendingBulkDelete={setPendingBulkDelete} setSelectedDenoms={setSelectedDenoms} allDenomsSelected={allDenomsSelected} toggleSelectAllDenoms={toggleSelectAllDenoms} selectedDenoms={selectedDenoms} toggleDenomSelected={toggleDenomSelected} statsByDenom={statsByDenom} toggleDenominationActive={toggleDenominationActive} togglingDenom={togglingDenom} setPendingDeleteDenom={setPendingDeleteDenom} setShowDeleted={setShowDeleted} showDeleted={showDeleted} deletedQuery={deletedQuery} archiveSelected={archiveSelected} />

      <ProductDetailDeleteThisDenomination pendingDeleteDenom={pendingDeleteDenom} setPendingDeleteDenom={setPendingDeleteDenom} deleteDenomination={deleteDenomination} />
      {pendingBulkDelete && (
        <ConfirmDialog open onOpenChange={open => { if (!open) setPendingBulkDelete(null); }}
          title={`Delete ${pendingBulkDelete.length} selected denomination(s)?`}
          description="Only the selected rows in this product will be removed from sale. This table shows all current denominations without pagination. Order and stock history are retained. Supplier SKUs stay excluded from sync until explicitly restored. Deactivate only pauses sales; Delete also hides the row."
          confirmLabel="Delete selected" onConfirm={() => archiveSelected(pendingBulkDelete)} />
      )}
    </PageLayout>
  );
}

function ProductDetailSummary({ product, navigate, toggleProductActive, togglingProduct, editingProduct, setNameDraft, setDescriptionDraft, setGameVariantDraft, setGameVariantEmojiDraft, setGameRegionDraft, setWhatYouGetDraft, setTermsDraft, setWarrantyNoteDraft, setCategoryDraft, setThumbnailKindDraft, setCurrencyIconKindDraft, setEditingProduct }: {
  product: ProductDetail;
  navigate: import("react-router-dom").NavigateFunction;
  toggleProductActive: (id: number, active: boolean) => Promise<void>;
  togglingProduct: Set<number>;
  editingProduct: boolean;
  setNameDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setDescriptionDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setGameVariantDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setGameVariantEmojiDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setGameRegionDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setWhatYouGetDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setTermsDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setWarrantyNoteDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setCategoryDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setThumbnailKindDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setCurrencyIconKindDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setEditingProduct: import("react").Dispatch<import("react").SetStateAction<boolean>>;
}) {
  return (<Card className="mb-4">
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
  </Card>);
}

function ProductGamePresentationFields({ isGame, fieldId, thumbnailKindDraft, setThumbnailKindDraft, currencyIconKindDraft, setCurrencyIconKindDraft }: {
  isGame: boolean;
  fieldId: string;
  thumbnailKindDraft: string;
  setThumbnailKindDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  currencyIconKindDraft: string;
  setCurrencyIconKindDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
}) {
  return (isGame && (
    <>
      <div>
        <label htmlFor={`${fieldId}-gaya-thumbnail-default-4`} className="text-sm font-medium text-ink" id="product-thumbnail-kind-label">
          Gaya thumbnail default
        </label>
        <Select value={thumbnailKindDraft} onValueChange={setThumbnailKindDraft}>
          <SelectTrigger id={`${fieldId}-gaya-thumbnail-default-4`} className="mt-1" aria-labelledby="product-thumbnail-kind-label">
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
        <label htmlFor={`${fieldId}-ikon-currency-5`} className="text-sm font-medium text-ink" id="product-currency-icon-kind-label">
          Ikon currency
        </label>
        <Select value={currencyIconKindDraft} onValueChange={setCurrencyIconKindDraft}>
          <SelectTrigger id={`${fieldId}-ikon-currency-5`} className="mt-1" aria-labelledby="product-currency-icon-kind-label">
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
  ));
}

function ProductGameFields({ isGame, fieldId, gameVariantEmojiDraft, gameVariantDraft, setGameVariantDraft, setGameVariantEmojiDraft, gameRegionDraft, setGameRegionDraft }: {
  isGame: boolean;
  fieldId: string;
  gameVariantEmojiDraft: string;
  gameVariantDraft: string;
  setGameVariantDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  setGameVariantEmojiDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  gameRegionDraft: string;
  setGameRegionDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
}) {
  return (isGame && (
    <>
      {/* Game-navigation classification (Task 8/14) — optional, powers
                    the bot's catalog navigation and denomination labeling for
                    game top-up products (e.g. Mobile Legends' Diamonds variant). */}
      <div>
        <label htmlFor={`${fieldId}-game-variant-6`} className="text-sm font-medium text-ink">Game Variant</label>
        <ButtonLabelInput id={`${fieldId}-game-variant-6`}
          kind="gameVariant"
          emoji={gameVariantEmojiDraft.trim() !== ""}
          className="mt-1"
          placeholder="e.g. Diamonds"
          value={gameVariantDraft}
          onChange={(e) => setGameVariantDraft(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={`${fieldId}-game-variant-emoji-7`} className="text-sm font-medium text-ink">Game Variant Emoji</label>
        <Input id={`${fieldId}-game-variant-emoji-7`}
          className="mt-1 w-24"
          placeholder="e.g. 💎"
          value={gameVariantEmojiDraft}
          onChange={(e) => setGameVariantEmojiDraft(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={`${fieldId}-game-region-8`} className="text-sm font-medium text-ink">Game Region</label>
        <ButtonLabelInput id={`${fieldId}-game-region-8`}
          kind="gameRegion"
          className="mt-1"
          placeholder="e.g. Global"
          value={gameRegionDraft}
          onChange={(e) => setGameRegionDraft(e.target.value)}
        />
      </div>
    </>
  ));
}

function ProductDenominationsSection({ product, navigate, productId, visibleSelectedDenoms, bulkActing, bulkSetDenomActive, setPendingBulkDelete, setSelectedDenoms, allDenomsSelected, toggleSelectAllDenoms, selectedDenoms, toggleDenomSelected, statsByDenom, toggleDenominationActive, togglingDenom, setPendingDeleteDenom, setShowDeleted, showDeleted, deletedQuery, archiveSelected }: {
  product: ProductDetail;
  navigate: import("react-router-dom").NavigateFunction;
  productId: string | undefined;
  visibleSelectedDenoms: Set<number>;
  bulkActing: boolean;
  bulkSetDenomActive: (active: boolean, ids: number[]) => Promise<void>;
  setPendingBulkDelete: import("react").Dispatch<import("react").SetStateAction<number[] | null>>;
  setSelectedDenoms: import("react").Dispatch<import("react").SetStateAction<Set<number>>>;
  allDenomsSelected: boolean;
  toggleSelectAllDenoms: () => void;
  selectedDenoms: Set<number>;
  toggleDenomSelected: (id: number) => void;
  statsByDenom: Record<string, DenomStat>;
  toggleDenominationActive: (id: number, active: boolean) => Promise<void>;
  togglingDenom: Set<number>;
  setPendingDeleteDenom: import("react").Dispatch<import("react").SetStateAction<DenominationRow | null>>;
  setShowDeleted: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  showDeleted: boolean;
  deletedQuery: import("@tanstack/react-query").UseQueryResult<NoInfer<{ denominations: { id: number; name: string; }[]; }>, Error>;
  archiveSelected: (ids: number[], restore?: boolean) => Promise<void>;
}) {
  return (<Card>
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
          <Button size="sm" variant="destructive" disabled={bulkActing} onClick={() => setPendingBulkDelete(Array.from(visibleSelectedDenoms))}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete selected
          </Button>
          <Button size="sm" variant="ghost" disabled={bulkActing} onClick={() => setSelectedDenoms(new Set())}>
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
                disabled={bulkActing || product.denominations.length === 0}
                aria-label="Select all denominations"
              />
            ),
            render: d => (
              <Checkbox
                checked={selectedDenoms.has(d.id)}
                disabled={bulkActing}
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
          { key: "price", header: "Price", className: "text-right tabular-nums", render: d => <span className="font-medium">{formatCurrencyDisplay(d.price, "IDR")}</span> },
          { key: "pricingSource", header: "Sumber harga", render: d => { const p = statsByDenom[String(d.id)]?.pricing; return p ? <PricingSourceBadge pricing={p} /> : "?"; } },
          { key: "margin", header: "Margin (sebelum biaya/diskon)", className: "text-right tabular-nums", render: d => { const p = statsByDenom[String(d.id)]?.pricing; return p ? <PricingMargin pricing={p} /> : "?"; } },
          {
            key: "stock",
            header: "Stock",
            // "—" (not a fake 0) when the server sent no stat for this
            // denomination at all. A SKU that holds no local stock rows
            // (supplier API or manual hand-off) shows where it is fulfilled
            // from instead of a meaningless 0; a genuine 0 on a
            // stock-backed SKU that has sold out still renders as 0.
            render: d => {
              const stat = statsByDenom[String(d.id)];
              if (!stat) return <span className="text-sm">—</span>;
              if (stat.usesLocalInventory === false) {
                return (
                  <span className="text-sm text-ink-soft">
                    {stat.fulfillmentSource === "PROVIDER_API" ? "Provider" : "Manual"}
                  </span>
                );
              }
              return <span className="text-sm">{stat.available}</span>;
            },
          },
          {
            key: "waiting",
            header: <RestockRequestsHeader />,
            render: d => {
              const stat = statsByDenom[String(d.id)];
              // A restock request only means something for a stock-backed SKU.
              const shown = stat?.usesLocalInventory === false ? "—" : formatRestockRequests(stat?.waiting, stat?.available);
              return <span className="text-sm text-ink-soft">{shown}</span>;
            },
          },
          {
            key: "active",
            header: "Active",
            render: d => (
              <Switch
                checked={d.isActive}
                onCheckedChange={(checked) => void toggleDenominationActive(d.id, checked)}
                disabled={bulkActing || togglingDenom.has(d.id)}
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
                    <Button variant="ghost" size="icon-sm" disabled={bulkActing} aria-label={`Actions for ${d.name}`}>
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
      <Button className="mt-3" variant="ghost" size="sm" onClick={() => setShowDeleted(value => !value)}>
        {showDeleted ? "Hide deleted denominations" : "Show deleted denominations"}
      </Button>
      {showDeleted && (
        <div className="mt-3 space-y-2">
          {deletedQuery.isPending && <p role="status">Loading deleted denominations…</p>}
          {deletedQuery.isError && <p role="alert">Failed to load deleted denominations.</p>}
          {deletedQuery.data?.denominations.length === 0 && <p>No deleted denominations.</p>}
          {deletedQuery.data?.denominations.map(row => (
            <div key={row.id} className="flex items-center justify-between gap-3">
              <span>{row.name}</span>
              <Button variant="outline" size="sm" disabled={bulkActing} onClick={() => void archiveSelected([row.id], true)}>Restore inactive</Button>
            </div>
          ))}
        </div>
      )}
    </CardContent>
  </Card>);
}

function useProductStateActions({ setTogglingProduct, queryClient, productId, setTogglingDenom }: {
  setTogglingProduct: import("react").Dispatch<import("react").SetStateAction<Set<number>>>;
  queryClient: import("@tanstack/react-query").QueryClient;
  productId: string | undefined;
  setTogglingDenom: import("react").Dispatch<import("react").SetStateAction<Set<number>>>;
}) {
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
      await queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
      toast.success("Denomination deleted.");
    } catch (e) {
      toast.error(describeError(e, "Failed to delete denomination."));
    }
  }
  return { toggleProductActive, toggleDenominationActive, deleteDenomination };
}

function useProductEditorSave({ setSavingProduct, setProductError, productId, nameDraft, descriptionDraft, isGame, gameVariantDraft, data, gameVariantEmojiDraft, gameRegionDraft, whatYouGetDraft, termsDraft, warrantyNoteDraft, thumbnailKindDraft, currencyIconKindDraft, categoryDraft, setEditingProduct, queryClient }: {
  setSavingProduct: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setProductError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  productId: string | undefined;
  nameDraft: string;
  descriptionDraft: string;
  isGame: boolean;
  gameVariantDraft: string;
  data: NoInfer<ProductDetailData> | undefined;
  gameVariantEmojiDraft: string;
  gameRegionDraft: string;
  whatYouGetDraft: string;
  termsDraft: string;
  warrantyNoteDraft: string;
  thumbnailKindDraft: string;
  currencyIconKindDraft: string;
  categoryDraft: string;
  setEditingProduct: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  queryClient: import("@tanstack/react-query").QueryClient;
}) {
  async function saveProduct() {
    setSavingProduct(true);
    setProductError(null);
    try {
      await apiPatch(`/api/catalog/products/${productId}`, {
        name: nameDraft.trim(),
        description: descriptionDraft.trim(),
        gameVariant: isGame ? gameVariantDraft.trim() : data?.product.gameVariant ?? null,
        gameVariantEmoji: isGame ? gameVariantEmojiDraft.trim() : data?.product.gameVariantEmoji ?? null,
        gameRegion: isGame ? gameRegionDraft.trim() : data?.product.gameRegion ?? null,
        whatYouGet: whatYouGetDraft.trim(),
        terms: termsDraft.trim(),
        warrantyNote: warrantyNoteDraft.trim(),
        thumbnailKind: isGame ? (thumbnailKindDraft === AUTO_KIND ? null : thumbnailKindDraft) : data?.product.thumbnailKind ?? null,
        currencyIconKind: isGame ? (currencyIconKindDraft === AUTO_KIND ? null : currencyIconKindDraft) : data?.product.currencyIconKind ?? null,
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
  return { saveProduct } as const;
}

function ProductCategoryOptions({ categories }: { categories: NonNullable<ReturnType<typeof useCatalog>["data"]>["categories"] }) {
  return <>                   {categories.map((cat) => (
    <SelectItem key={cat.id} value={String(cat.id)}>
      {cat.emoji ? `${cat.emoji} ` : ""}
      {cat.name}
      {cat.isActive ? "" : " (inactive)"}
    </SelectItem>
  ))}
  </>;
}

function ProductCategoryField({ fieldId, categoryDraft, setCategoryDraft, catalog }: {
  fieldId: string;
  categoryDraft: string;
  setCategoryDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  catalog: NonNullable<import("@tanstack/react-query").UseQueryResult<NoInfer<import("../api/catalog").CatalogData>, Error>>["data"];
}) {
  return (<div>
    <label htmlFor={`${fieldId}-category-1`} className="text-sm font-medium text-ink" id="product-category-label">Category</label>
    <Select value={categoryDraft} onValueChange={setCategoryDraft}>
      <SelectTrigger id={`${fieldId}-category-1`} className="mt-1" aria-labelledby="product-category-label">
        <SelectValue placeholder="Pick a category" />
      </SelectTrigger>
      <SelectContent>
        <ProductCategoryOptions categories={catalog?.categories ?? []} />
      </SelectContent>
    </Select>
  </div>);
}

function ProductEditorActions({ nameDraft, savingProduct, saveProduct, setEditingProduct, setProductError }: {
  nameDraft: string;
  savingProduct: boolean;
  saveProduct: NonNullable<{ readonly saveProduct: () => Promise<void>; }>["saveProduct"];
  setEditingProduct: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setProductError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
}) {
  return (<div className="flex gap-2">
    <Button size="sm" disabled={!nameDraft.trim() || savingProduct} onClick={() => void saveProduct()}>
      <Save className="h-4 w-4" />
      {savingProduct ? "Saving…" : "Save"}
    </Button>
    <Button size="sm" variant="ghost" onClick={() => { setEditingProduct(false); setProductError(null); }}>
      <X className="h-4 w-4" />
      Cancel
    </Button>
  </div>);
}

function ProductPhotoField({ product, productId, queryClient }: {
  product: NonNullable<ProductDetailData>["product"];
  productId: NonNullable<Readonly<Partial<{ productId: string; }>>>["productId"];
  queryClient: import("@tanstack/react-query").QueryClient;
}) {
  return (<div className="mb-4 max-w-sm">
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
  </div>);
}

function ProductDetailDeleteThisDenomination({ pendingDeleteDenom, setPendingDeleteDenom, deleteDenomination }: {
  pendingDeleteDenom: DenominationRow | null;
  setPendingDeleteDenom: import("react").Dispatch<import("react").SetStateAction<DenominationRow | null>>;
  deleteDenomination: NonNullable<{ toggleProductActive: (id: number, active: boolean) => Promise<void>; toggleDenominationActive: (id: number, active: boolean) => Promise<void>; deleteDenomination: (id: number) => Promise<void>; }>["deleteDenomination"];
}) {
  return (pendingDeleteDenom && (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) setPendingDeleteDenom(null); }}
      title="Delete this denomination?"
      description={pendingDeleteDenom.supplierSku ? `Remove "${pendingDeleteDenom.name}" from sale. Order history is retained. Supplier sync ignores this SKU until restored.` : `Delete "${pendingDeleteDenom.name}". Deletion is refused when it has order or stock history. Use Delete selected to archive while retaining history.`}
      confirmLabel="Delete"
      onConfirm={() => deleteDenomination(pendingDeleteDenom.id)}
    />
  ));
}
