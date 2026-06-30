import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
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
        <p className="text-sm text-rust">Failed to load product.</p>
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
      <PageHeader
        title={product.name}
        breadcrumb={[{ label: "Stock", href: "/stock" }]}
        actions={<Button variant="outline" size="sm" onClick={() => navigate("/stock")}>← Back</Button>}
      />

      {/* Stats row */}
      <div className="mb-4 flex gap-4 text-sm">
        <span className="text-ink-soft">Product: <span className="text-ink">{product.product?.name ?? "—"}</span></span>
        <span className="text-ink-soft">Category: <span className="text-ink">{product.product?.category?.name ?? "—"}</span></span>
        <span className="text-ink-soft">Available: <span className="font-semibold text-ink">{available}</span></span>
        <span className="text-ink-soft">Waiting: <span className="text-ink">{waiting}</span></span>
      </div>

      {/* Bulk add */}
      <Card className="mb-6">
        <CardHeader><CardTitle>Bulk Add Credentials</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {bulkMsg && <p className="text-sm text-grass">{bulkMsg}</p>}
          {bulkError && <p className="text-sm text-rust">{bulkError}</p>}
          <Textarea
            value={credentials}
            onChange={e => setCredentials(e.target.value)}
            placeholder="One credential per line…"
            rows={6}
            className="font-mono text-sm"
          />
          <Button onClick={() => bulkAdd.mutate()} disabled={bulkAdd.isPending || !credentials.trim()} className="self-start">
            {bulkAdd.isPending ? "Adding…" : "Add Stock"}
          </Button>
        </CardContent>
      </Card>

      {/* Items table */}
      <h2 className="text-sm font-semibold text-ink mb-3">Stock Items ({items.length})</h2>
      <DataTable
        columns={[
          { key: "id", header: "#", render: item => <span className="font-mono text-xs text-ink-soft">{item.id}</span> },
          { key: "status", header: "Status", render: item => <StatusBadge status={item.status} /> },
          { key: "note", header: "Note", render: item => <span className="text-xs text-ink-soft">{item.note ?? "—"}</span> },
          { key: "added", header: "Added", render: item => <span className="text-xs text-ink-faint">{new Date(item.createdAt).toLocaleDateString()}</span> },
        ]}
        data={items}
        keyExtractor={item => item.id}
        empty={<EmptyState title="No stock items" description="Add credentials above to stock this denomination." />}
      />
    </PageLayout>
  );
}
