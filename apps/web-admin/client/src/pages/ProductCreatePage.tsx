import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { apiPost } from "../api/client";

interface CategoryRow {
  id: number;
  name: string;
  isActive: boolean;
}

interface CatalogData {
  categories: CategoryRow[];
  products: unknown[];
}

const NEW_CATEGORY_SENTINEL = "__new__";

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

export function ProductCreatePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data } = useCatalog();
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [emoji, setEmoji] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const createCategory = useMutation({
    mutationFn: () =>
      apiPost<{ category: { id: number; name: string } }>("/api/catalog/categories", {
        name: newCategoryName.trim(),
      }),
    onMutate: () => setCategoryError(null),
    onSuccess: ({ category }) => {
      void qc.invalidateQueries({ queryKey: ["catalog"] });
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
      }),
    onMutate: () => setError(null),
    onSuccess: (product) => {
      void qc.invalidateQueries({ queryKey: ["catalog"] });
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
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate("/catalog")}>
            ← Back
          </Button>
        }
      />

      <div className="max-w-lg flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium text-ink">
            Category <span className="text-rust">*</span>
          </label>
          {creatingCategory ? (
            <div className="mt-1 flex flex-col gap-2">
              <Input
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
                {(data?.categories ?? []).map((cat) => (
                  <SelectItem key={cat.id} value={String(cat.id)}>
                    {cat.name}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_CATEGORY_SENTINEL}>+ New category</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>

        <div>
          <label className="text-sm font-medium text-ink">
            Name <span className="text-rust">*</span>
          </label>
          <Input
            className="mt-1"
            placeholder="e.g. CapCut Pro"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Emoji</label>
          <Input
            className="mt-1 w-24"
            placeholder="e.g. 🎬"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Description</label>
          <Textarea
            className="mt-1"
            rows={3}
            placeholder="Short description shown on the storefront."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
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
