import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { apiPost } from "../api/client";

interface StockItem {
  id: number;
  status: string;
  note: string | null;
  createdAt: string;
}

interface StockProductData {
  product: {
    id: number;
    name: string;
    isActive: boolean;
    product: { id: number; name: string; category: { name: string } | null } | null;
  };
  items: StockItem[];
  available: number;
  waiting: number;
}

function useStockProduct(productId: string) {
  return useQuery<StockProductData>({
    queryKey: ["stock", productId],
    queryFn: async () => {
      const res = await fetch(`/api/stock/${productId}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<StockProductData>;
    },
    enabled: !!productId,
  });
}

export function StockProductPage() {
  const { productId } = useParams<{ productId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isError } = useStockProduct(productId ?? "");
  const [credentials, setCredentials] = useState("");
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const bulkAdd = useMutation({
    mutationFn: () =>
      apiPost<{ ok: boolean; added: number; skipped: number; message: string }>(
        `/api/stock/${productId}/bulk-add`,
        { credentials },
      ),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["stock", productId] });
      setCredentials("");
      setBulkMsg(result.message);
      setBulkError(null);
    },
    onError: (e: Error) => {
      setBulkError(e.message);
      setBulkMsg(null);
    },
  });

  if (isError) {
    return (
      <PageLayout title="Stock — Product">
        <p style={{ color: "red" }}>Failed to load product.</p>
      </PageLayout>
    );
  }
  if (!data) {
    return (
      <PageLayout title="Stock — Product">
        <p>Loading…</p>
      </PageLayout>
    );
  }

  const { product, items, available, waiting } = data;

  return (
    <PageLayout title={product.name}>
      <button
        onClick={() => navigate("/stock")}
        style={{
          marginBottom: 16,
          background: "none",
          border: "1px solid #ccc",
          borderRadius: 4,
          padding: "4px 12px",
          cursor: "pointer",
        }}
      >
        ← Back to Stock
      </button>

      <section style={{ marginBottom: 16 }}>
        <p>
          <strong>Product:</strong> {product.product?.name ?? "—"}
        </p>
        <p>
          <strong>Category:</strong> {product.product?.category?.name ?? "—"}
        </p>
        <p>
          <strong>Available:</strong> {available} &nbsp; <strong>Waiting:</strong> {waiting}
        </p>
      </section>

      <section
        style={{ background: "#f9f9f9", padding: 16, borderRadius: 6, marginBottom: 20 }}
      >
        <h2 style={{ fontSize: 15, marginBottom: 10 }}>Bulk Add Credentials</h2>
        {bulkMsg && <p style={{ color: "green", margin: "0 0 8px" }}>{bulkMsg}</p>}
        {bulkError && <p style={{ color: "red", margin: "0 0 8px" }}>{bulkError}</p>}
        <textarea
          value={credentials}
          onChange={(e) => setCredentials(e.target.value)}
          placeholder="One credential per line…"
          rows={6}
          style={{ width: "100%", padding: "6px 8px", boxSizing: "border-box", fontFamily: "monospace" }}
        />
        <button
          onClick={() => bulkAdd.mutate()}
          disabled={bulkAdd.isPending || !credentials.trim()}
          style={{ marginTop: 8, padding: "6px 16px" }}
        >
          {bulkAdd.isPending ? "Adding…" : "Add Stock"}
        </button>
      </section>

      <section>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>
          Stock Items ({items.length})
        </h2>
        {items.length === 0 ? (
          <p>No stock items.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f5f5f5" }}>
                <th style={{ textAlign: "left", padding: "5px 8px" }}>#</th>
                <th style={{ textAlign: "left", padding: "5px 8px" }}>Status</th>
                <th style={{ textAlign: "left", padding: "5px 8px" }}>Note</th>
                <th style={{ textAlign: "left", padding: "5px 8px" }}>Added</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={{ borderTop: "1px solid #eee" }}>
                  <td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{item.id}</td>
                  <td style={{ padding: "5px 8px" }}>{item.status}</td>
                  <td style={{ padding: "5px 8px", color: "#666" }}>{item.note ?? "—"}</td>
                  <td style={{ padding: "5px 8px", fontSize: 12 }}>
                    {new Date(item.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </PageLayout>
  );
}
