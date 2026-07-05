import { useState } from "react";
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
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";
import { apiGet, apiPost, apiPatch, apiDelete } from "../api/client";

interface DenominationRow {
  id: number;
  name: string;
  price: string;
  costPrice: string | null;
  isActive: boolean;
  type: string;
  durationLabel: string;
}

interface ProductDetail {
  id: number;
  name: string;
  description: string | null;
  isActive: boolean;
  webImageUrl: string | null;
  category: { id: number; name: string } | null;
  denominations: DenominationRow[];
}

interface DenomStat {
  id: number;
  available: number;
  waiting: number;
  rule: { minQuantity: number; discountPercent: string } | null;
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
  const queryClient = useQueryClient();
  const [togglingProduct, setTogglingProduct] = useState<Set<number>>(new Set());
  const [togglingDenom, setTogglingDenom] = useState<Set<number>>(new Set());
  const [editingProduct, setEditingProduct] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [savingProduct, setSavingProduct] = useState(false);
  const [productError, setProductError] = useState<string | null>(null);

  async function saveProduct() {
    setSavingProduct(true);
    setProductError(null);
    try {
      await apiPatch(`/api/catalog/products/${productId}`, {
        name: nameDraft.trim(),
        description: descriptionDraft.trim(),
      });
      setEditingProduct(false);
      await queryClient.invalidateQueries({ queryKey: ["catalog", productId] });
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
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete denomination.");
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

  return (
    <PageLayout title={product.name}>
      <PageHeader
        title={product.name}
        breadcrumb={[{ label: "Catalog", href: "/catalog" }]}
        actions={<Button variant="outline" size="sm" onClick={() => navigate("/catalog")}>← Back</Button>}
      />

      <Card className="mb-4">
        <CardContent className="flex items-center gap-4 text-sm">
          <span className="text-ink-soft">Category: <span className="text-ink">{product.category?.name ?? "—"}</span></span>
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
                setEditingProduct(true);
              }}
            >
              Edit name/description
            </Button>
          )}
        </CardContent>
      </Card>

      {editingProduct && (
        <Card className="mb-4 max-w-lg">
          <CardContent className="flex flex-col gap-3">
            <div>
              <label className="text-sm font-medium text-ink">Name</label>
              <Input className="mt-1" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium text-ink">Description</label>
              <Textarea className="mt-1" rows={3} value={descriptionDraft} onChange={(e) => setDescriptionDraft(e.target.value)} />
            </div>
            {productError && <p className="text-sm text-rust">{productError}</p>}
            <div className="flex gap-2">
              <Button size="sm" disabled={!nameDraft.trim() || savingProduct} onClick={() => void saveProduct()}>
                {savingProduct ? "Saving…" : "Save"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditingProduct(false); setProductError(null); }}>
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
          onUploaded={() => void queryClient.invalidateQueries({ queryKey: ["catalog", productId] })}
        />
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-ink">Denominations ({product.denominations.length})</h2>
        <Button size="sm" onClick={() => navigate(`/catalog/${productId}/denominations/new`)}>
          + Add Denomination
        </Button>
      </div>
      <DataTable
        columns={[
          { key: "name", header: "Name", render: d => <span className={`text-sm ${!d.isActive ? "text-ink-faint" : "text-ink"}`}>{d.name}</span> },
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
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => navigate(`/catalog/${productId}/denominations/${d.id}/edit`)}>
                  Edit
                </Button>
                <ConfirmDialog
                  trigger={<Button variant="ghost" size="sm" className="text-rust">Delete</Button>}
                  title="Delete this denomination?"
                  description={`Delete "${d.name}". This is refused if it has order history.`}
                  confirmLabel="Delete"
                  onConfirm={() => deleteDenomination(d.id)}
                />
              </div>
            ),
          },
        ]}
        data={product.denominations}
        keyExtractor={d => d.id}
        empty={<EmptyState title="No denominations" />}
      />
    </PageLayout>
  );
}
