import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { ImageUploadField } from "../components/shared/ImageUploadField";
import { StatusBadge } from "../components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
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
import { useGames } from "../api/games";
import { describeError } from "../lib/errorMessages";
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
  category: { id: number; name: string } | null;
  denominations: DenominationRow[];
  /** Admin-authored game-navigation classification (Task 8/14) — the bot's
   * catalog navigation and denomination labeling (Tasks 11-13) key off
   * these three, null until an admin sets them. */
  gameVariant: string | null;
  gameVariantEmoji: string | null;
  gameRegion: string | null;
  /** Structural link (Task 10/12) to the canonical Game catalog model that
   * drives the multi-provider nickname check — distinct from the three
   * free-text fields above. Null until an admin links a Game. */
  gameId: number | null;
}

interface DenomStat {
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
  const { data: games } = useGames();
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
  // Linked Game (Task 10/12) — structural FK to the new Game catalog model,
  // independent of the three cosmetic fields above. "" means no game linked
  // (null); a Select item's value can't itself be an empty string (Radix),
  // so this stores the numeric id as a string and maps "" <-> null at the
  // save-payload boundary.
  const [gameIdDraft, setGameIdDraft] = useState("");
  // Storefront detail blocks — each renders as its own titled section on the
  // product page, and stays hidden there while it's blank.
  const [whatYouGetDraft, setWhatYouGetDraft] = useState("");
  const [termsDraft, setTermsDraft] = useState("");
  const [warrantyNoteDraft, setWarrantyNoteDraft] = useState("");
  const [categoryDraft, setCategoryDraft] = useState<string>("");
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
        gameId: gameIdDraft ? Number(gameIdDraft) : null,
        whatYouGet: whatYouGetDraft.trim(),
        terms: termsDraft.trim(),
        warrantyNote: warrantyNoteDraft.trim(),
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
      toast.error(describeError(e instanceof Error ? e.message : "Failed to delete denomination."));
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
      toast.error(describeError(e instanceof Error ? e.message : "Failed to update denominations."));
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
                setGameIdDraft(product.gameId != null ? String(product.gameId) : "");
                setWhatYouGetDraft(product.whatYouGet ?? "");
                setTermsDraft(product.terms ?? "");
                setWarrantyNoteDraft(product.warrantyNote ?? "");
                setCategoryDraft(product.category ? String(product.category.id) : "");
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
              <Input className="mt-1" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium text-ink">Description</label>
              <Textarea className="mt-1" rows={3} value={descriptionDraft} onChange={(e) => setDescriptionDraft(e.target.value)} />
            </div>
            {/* Game-navigation classification (Task 8/14) — optional, powers
                the bot's catalog navigation and denomination labeling for
                game top-up products (e.g. Mobile Legends' Diamonds variant). */}
            <div>
              <label className="text-sm font-medium text-ink">Game Variant</label>
              <Input
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
              <Input
                className="mt-1"
                placeholder="e.g. Global"
                value={gameRegionDraft}
                onChange={(e) => setGameRegionDraft(e.target.value)}
              />
            </div>
            {/* Linked Game (Task 10/12) — a structural link to the new Game
                catalog model powering the multi-provider nickname check.
                Distinct from the three fields above: those are free-text
                cosmetic labels for bot navigation, this is a nullable FK
                (Game.id) validated server-side against active Games. */}
            <div>
              <label className="text-sm font-medium text-ink" id="product-linked-game-label">Linked Game</label>
              <Select
                value={gameIdDraft || "none"}
                onValueChange={(v) => setGameIdDraft(v === "none" ? "" : v)}
              >
                <SelectTrigger className="mt-1" aria-labelledby="product-linked-game-label">
                  <SelectValue placeholder="No linked game" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No linked game</SelectItem>
                  {(games?.games ?? []).map((g) => (
                    <SelectItem key={g.id} value={String(g.id)}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-ink-soft">
                Links this product to a Game for the new multi-provider nickname check.
              </p>
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

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-ink">Denominations ({product.denominations.length})</h2>
        <Button size="sm" onClick={() => navigate(`/catalog/${productId}/denominations/new`)}>
          <Plus className="h-4 w-4" />
          Add Denomination
        </Button>
      </div>

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
          { key: "stock", header: "Stock", render: d => { const stat = statsByDenom[String(d.id)]; return <span className="text-sm">{stat?.available ?? 0}</span>; } },
          { key: "waiting", header: "Waiting", render: d => { const stat = statsByDenom[String(d.id)]; return <span className="text-sm text-ink-soft">{stat?.waiting ?? 0}</span>; } },
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
