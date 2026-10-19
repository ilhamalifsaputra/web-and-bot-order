import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CATALOG_QUERY_KEY, useCatalog } from "../api/catalog";
import { apiPost } from "../api/client";
import { ButtonLabelInput } from "../components/shared/ButtonLabelInput";
import { PageHeader } from "../components/shared/PageHeader";
import { PageLayout } from "../components/shared/PageLayout";

const NEW_CATEGORY_SENTINEL = "__new__";

export function ProductCreatePage() {
  const fieldId = useId();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data } = useCatalog();
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [emoji, setEmoji] = useState("");
  const [description, setDescription] = useState("");
  // Game-navigation classification (Task 8/14) — bot navigation and
  // denomination labeling (Tasks 11-13) key off these three. Independent of
  // each other and of every other field on this form.
  const [gameVariant, setGameVariant] = useState("");
  const [gameVariantEmoji, setGameVariantEmoji] = useState("");
  const [gameRegion, setGameRegion] = useState("");
  const [whatYouGet, setWhatYouGet] = useState("");
  const [terms, setTerms] = useState("");
  const [warrantyNote, setWarrantyNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const activeCategories = (data?.categories ?? []).filter((c) => c.isActive);
  const inactiveCategories = (data?.categories ?? []).filter((c) => !c.isActive);

  const isGame = data?.categories.find((c) => c.id === categoryId)?.group === "GAME_TOPUP";

  const createCategory = useMutation({
    mutationFn: () =>
      apiPost<{ category: { id: number; name: string } }>("/api/catalog/categories", {
        name: newCategoryName.trim(),
      }),
    onMutate: () => setCategoryError(null),
    onSuccess: ({ category }) => {
      void qc.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
      setCategoryId(category.id);
      setCreatingCategory(false);
      setNewCategoryName("");
    },
    onError: (e: Error) => setCategoryError(e.message),
  });

  const create = useMutation({
    mutationFn: () =>
      apiPost<{ id: number; name: string; slug: string }>("/api/catalog/products", {
        name: name.trim(),
        categoryId: categoryId!,
        ...(emoji.trim() ? { emoji: emoji.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(isGame && gameVariant.trim() ? { gameVariant: gameVariant.trim() } : {}),
        ...(isGame && gameVariantEmoji.trim() ? { gameVariantEmoji: gameVariantEmoji.trim() } : {}),
        ...(isGame && gameRegion.trim() ? { gameRegion: gameRegion.trim() } : {}),
        ...(whatYouGet.trim() ? { whatYouGet: whatYouGet.trim() } : {}),
        ...(terms.trim() ? { terms: terms.trim() } : {}),
        ...(warrantyNote.trim() ? { warrantyNote: warrantyNote.trim() } : {}),
      }),
    onMutate: () => setError(null),
    onSuccess: (product) => {
      void qc.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
      navigate(`/catalog/${product.id}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const canSubmit = name.trim().length > 0 && categoryId !== null;

  return (
    <PageLayout title="New Product">
      <PageHeader
        title="New Product"
        breadcrumb={[{ label: "Catalog", href: "/catalog" }]}
      />

      <div className="max-w-lg flex flex-col gap-4">
        <fieldset>
          <legend className="text-sm font-medium text-ink">
            Category <span className="text-rust">*</span>
          </legend>
          {creatingCategory ? (
            <div className="mt-1 flex flex-col gap-2">
              <ButtonLabelInput
                kind="category"
                autoFocus
                placeholder="New category name"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
              />
              {categoryError && <p className="text-sm text-rust">{categoryError}</p>}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={newCategoryName.trim().length === 0 || createCategory.isPending}
                  onClick={() => createCategory.mutate()}
                >
                  {createCategory.isPending ? "Creating…" : "Confirm"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCreatingCategory(false);
                    setNewCategoryName("");
                    setCategoryError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Select
              value={categoryId !== null ? String(categoryId) : ""}
              onValueChange={(v) => {
                if (v === NEW_CATEGORY_SENTINEL) {
                  setCreatingCategory(true);
                  return;
                }
                setCategoryId(Number(v));
              }}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {activeCategories.map((cat) => (
                  <SelectItem key={cat.id} value={String(cat.id)}>
                    {cat.emoji ? `${cat.emoji} ` : ""}
                    {cat.name}
                  </SelectItem>
                ))}
                {/* Separated rather than hidden: filing a product under a
                    switched-off category is occasionally deliberate (staging a
                    shelf before opening it), but it should never happen by
                    accident from a list that looks uniform. */}
                {inactiveCategories.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Inactive — hidden from the shop</SelectLabel>
                    {inactiveCategories.map((cat) => (
                      <SelectItem key={cat.id} value={String(cat.id)}>
                        {cat.emoji ? `${cat.emoji} ` : ""}
                        {cat.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                <SelectSeparator />
                <SelectItem value={NEW_CATEGORY_SENTINEL}>+ New category</SelectItem>
              </SelectContent>
            </Select>
          )}
        </fieldset>

        <div>
          <label htmlFor={`${fieldId}-name-1`} className="text-sm font-medium text-ink">
            Name <span className="text-rust">*</span>
          </label>
          <ButtonLabelInput id={`${fieldId}-name-1`}
            kind="productList"
            className="mt-1"
            placeholder="e.g. CapCut Pro"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor={`${fieldId}-emoji-2`} className="block text-sm font-medium text-ink">Emoji</label>
          <Input id={`${fieldId}-emoji-2`}
            className="mt-1 w-24"
            placeholder="e.g. 🎬"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
          />
        </div>

        {isGame && (
          <>
            {/* Game-navigation classification (Task 8/14) — optional, powers the
                bot's catalog navigation and denomination labeling for game
                top-up products (e.g. Mobile Legends' Diamonds variant). */}
            <div>
              <label htmlFor={`${fieldId}-game-variant-3`} className="block text-sm font-medium text-ink">Game Variant</label>
              <ButtonLabelInput id={`${fieldId}-game-variant-3`}
                kind="gameVariant"
                emoji={gameVariantEmoji.trim() !== ""}
                className="mt-1"
                placeholder="e.g. Diamonds"
                value={gameVariant}
                onChange={(e) => setGameVariant(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor={`${fieldId}-game-variant-emoji-4`} className="block text-sm font-medium text-ink">Game Variant Emoji</label>
              <Input id={`${fieldId}-game-variant-emoji-4`}
                className="mt-1 w-24"
                placeholder="e.g. 💎"
                value={gameVariantEmoji}
                onChange={(e) => setGameVariantEmoji(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor={`${fieldId}-game-region-5`} className="block text-sm font-medium text-ink">Game Region</label>
              <ButtonLabelInput id={`${fieldId}-game-region-5`}
                kind="gameRegion"
                className="mt-1"
                placeholder="e.g. Global"
                value={gameRegion}
                onChange={(e) => setGameRegion(e.target.value)}
              />
            </div>
          </>
        )}

        <div>
          <label htmlFor={`${fieldId}-description-6`} className="text-sm font-medium text-ink">Description</label>
          <Textarea id={`${fieldId}-description-6`}
            className="mt-1"
            rows={3}
            placeholder="Short description shown on the storefront."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* The three storefront detail blocks. Optional here — they can be
            filled in later from the product page — but offering them at
            creation is what stops products going live with nothing but a
            one-line description. */}
        <div>
          <label htmlFor={`${fieldId}-what-the-buyer-gets-7`} className="text-sm font-medium text-ink">What the buyer gets</label>
          <Textarea id={`${fieldId}-what-the-buyer-gets-7`}
            className="mt-1"
            rows={3}
            placeholder="Private account, 1 device&#10;Can change the profile name&#10;Active for 30 days"
            value={whatYouGet}
            onChange={(e) => setWhatYouGet(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor={`${fieldId}-terms-of-use-8`} className="text-sm font-medium text-ink">Terms of use</label>
          <Textarea id={`${fieldId}-terms-of-use-8`}
            className="mt-1"
            rows={2}
            placeholder="Don't change the account email or password — it voids the warranty."
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor={`${fieldId}-warranty-9`} className="text-sm font-medium text-ink">Warranty</label>
          <Textarea id={`${fieldId}-warranty-9`}
            className="mt-1"
            rows={2}
            placeholder="Full 30-day warranty, claimed through a support ticket."
            value={warrantyNote}
            onChange={(e) => setWarrantyNote(e.target.value)}
          />
        </div>

        {error && <p className="text-sm text-rust">{error}</p>}

        <Button
          disabled={!canSubmit || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Creating…" : "Create Product"}
        </Button>
      </div>
    </PageLayout>
  );
}
