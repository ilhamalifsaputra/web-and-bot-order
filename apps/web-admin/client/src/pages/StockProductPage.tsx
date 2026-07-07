import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { apiPost } from "../api/client";

interface StockItem {
  id: number;
  status: string;
  note: string | null;
  createdAtDisplay: string | null;
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
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

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

  function toggleSelected(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function bulkMarkDead() {
    setBulkActing(true);
    try {
      await apiPost(`/api/stock/${productId}/bulk-dead`, { ids: Array.from(selected) });
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["stock", productId] });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to mark items dead.");
    } finally {
      setBulkActing(false);
    }
  }

  async function bulkDelete() {
    setBulkActing(true);
    try {
      await apiPost(`/api/stock/${productId}/bulk-delete`, { ids: Array.from(selected) });
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["stock", productId] });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete items.");
    } finally {
      setBulkActing(false);
    }
  }

  async function markItemDead(id: number) {
    try {
      await apiPost(`/api/stock/item/${id}/dead`, {});
      await qc.invalidateQueries({ queryKey: ["stock", productId] });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to mark item dead.");
    }
  }

  async function saveNote(id: number) {
    try {
      await apiPost(`/api/stock/item/${id}/note`, { note: noteDraft });
      setEditingNoteId(null);
      await qc.invalidateQueries({ queryKey: ["stock", productId] });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to update note.");
    }
  }

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
        actions={
          <div className="flex items-center gap-2">
            <a href={`/api/stock/${productId}/download`}>
              <Button variant="outline" size="sm">Download credentials</Button>
            </a>
            <Button variant="outline" size="sm" onClick={() => navigate("/stock")}>← Back</Button>
          </div>
        }
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

      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-line bg-card px-3 py-2 text-sm">
          <span className="text-ink-soft">{selected.size} selected</span>
          <Button size="sm" variant="outline" disabled={bulkActing} onClick={() => void bulkMarkDead()}>
            Mark selected dead
          </Button>
          <ConfirmDialog
            trigger={<Button size="sm" variant="outline" disabled={bulkActing} className="text-rust">Delete</Button>}
            title="Delete selected stock items?"
            description={`Delete ${selected.size} stock item(s). Sold items or items tied to an order are skipped.`}
            confirmLabel="Delete"
            onConfirm={() => bulkDelete()}
          />
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <DataTable
        columns={[
          {
            key: "select",
            header: "",
            render: item => (
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={() => toggleSelected(item.id)}
                aria-label={`Select stock item ${item.id}`}
              />
            ),
          },
          { key: "id", header: "#", render: item => <span className="font-mono text-xs text-ink-soft">{item.id}</span> },
          { key: "status", header: "Status", render: item => <StatusBadge status={item.status} /> },
          {
            key: "note",
            header: "Note",
            render: item =>
              editingNoteId === item.id ? (
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Note for stock item ${item.id}`}
                    value={noteDraft}
                    onChange={e => setNoteDraft(e.target.value)}
                    className="h-7 text-xs max-w-[180px]"
                    autoFocus
                  />
                  <Button size="sm" variant="ghost" onClick={() => void saveNote(item.id)}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingNoteId(null)}>Cancel</Button>
                </div>
              ) : (
                <span className="text-xs text-ink-soft">{item.note ?? "—"}</span>
              ),
          },
          { key: "added", header: "Added", render: item => <span className="text-xs text-ink-soft">{item.createdAtDisplay ?? "—"}</span> },
          {
            key: "actions",
            header: "",
            render: item => (
              <div className="flex gap-2">
                {item.status !== "DEAD" && (
                  <ConfirmDialog
                    trigger={<Button variant="ghost" size="sm">Mark Dead</Button>}
                    title="Mark this stock item dead?"
                    description={`Mark stock item #${item.id} dead. This removes it from availability.`}
                    confirmLabel="Mark Dead"
                    onConfirm={() => markItemDead(item.id)}
                  />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setEditingNoteId(item.id); setNoteDraft(item.note ?? ""); }}
                >
                  Edit Note
                </Button>
              </div>
            ),
          },
        ]}
        data={items}
        keyExtractor={item => item.id}
        empty={<EmptyState title="No stock items" description="Add credentials above to stock this denomination." />}
      />
    </PageLayout>
  );
}
