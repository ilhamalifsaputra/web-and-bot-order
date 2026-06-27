import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";

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
    queryFn: async () => {
      const res = await fetch(`/api/catalog/${productId}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<ProductDetailData>;
    },
    enabled: !!productId,
  });
}

export function ProductDetailPage() {
  const { productId } = useParams<{ productId: string }>();
  const navigate = useNavigate();
  const { data, isError } = useProductDetail(productId ?? "");

  if (isError) {
    return (
      <PageLayout title="Product Detail">
        <p style={{ color: "red" }}>Failed to load product.</p>
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
      <button
        onClick={() => navigate("/catalog")}
        style={{
          marginBottom: 16,
          background: "none",
          border: "1px solid #ccc",
          borderRadius: 4,
          padding: "4px 12px",
          cursor: "pointer",
        }}
      >
        ← Back to Catalog
      </button>

      <section style={{ marginBottom: 20 }}>
        <p>
          <strong>Category:</strong> {product.category?.name ?? "—"}
        </p>
        <p>
          <strong>Status:</strong> {product.isActive ? "Active" : "Inactive"}
        </p>
      </section>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 10 }}>
          Denominations ({product.denominations.length})
        </h2>
        {product.denominations.length === 0 ? (
          <p>No denominations.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f5f5f5" }}>
                <th style={{ textAlign: "left", padding: "5px 8px" }}>Name</th>
                <th style={{ textAlign: "left", padding: "5px 8px" }}>Type</th>
                <th style={{ textAlign: "left", padding: "5px 8px" }}>Duration</th>
                <th style={{ textAlign: "right", padding: "5px 8px" }}>Price</th>
                <th style={{ textAlign: "center", padding: "5px 8px" }}>Stock</th>
                <th style={{ textAlign: "center", padding: "5px 8px" }}>Waiting</th>
                <th style={{ textAlign: "center", padding: "5px 8px" }}>Active</th>
              </tr>
            </thead>
            <tbody>
              {product.denominations.map((d) => {
                const stat = statsByDenom[String(d.id)];
                return (
                  <tr
                    key={d.id}
                    style={{
                      borderTop: "1px solid #eee",
                      color: d.isActive ? undefined : "#999",
                    }}
                  >
                    <td style={{ padding: "5px 8px" }}>{d.name}</td>
                    <td style={{ padding: "5px 8px" }}>{d.type}</td>
                    <td style={{ padding: "5px 8px" }}>{d.durationLabel}</td>
                    <td style={{ padding: "5px 8px", textAlign: "right" }}>{d.price}</td>
                    <td style={{ padding: "5px 8px", textAlign: "center" }}>
                      {stat?.available ?? 0}
                    </td>
                    <td style={{ padding: "5px 8px", textAlign: "center" }}>
                      {stat?.waiting ?? 0}
                    </td>
                    <td style={{ padding: "5px 8px", textAlign: "center" }}>
                      {d.isActive ? "Yes" : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </PageLayout>
  );
}
