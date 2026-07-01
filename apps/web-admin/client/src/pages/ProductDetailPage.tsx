import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { AlertCircle } from "lucide-react";
import { apiGet, apiPost } from "../api/client";

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
  isActive: boolean;
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

      <div className="mb-4 flex items-center gap-4 text-sm">
        <span className="text-ink-soft">Category: <span className="text-ink">{product.category?.name ?? "—"}</span></span>
        <div className="flex items-center gap-2">
          <Switch
            checked={product.isActive}
            onCheckedChange={(checked) => void toggleProductActive(product.id, checked)}
            disabled={togglingProduct.has(product.id)}
          />
          <span className="text-ink-soft">{product.isActive ? "Active" : "Inactive"}</span>
        </div>
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
          { key: "type", header: "Type", render: d => <Badge variant="outline">{d.type}</Badge> },
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
        ]}
        data={product.denominations}
        keyExtractor={d => d.id}
        empty={<EmptyState title="No denominations" />}
      />
    </PageLayout>
  );
}
