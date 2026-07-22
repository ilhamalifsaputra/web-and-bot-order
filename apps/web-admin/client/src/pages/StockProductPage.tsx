import { useState } from "react";
import { useParams } from "react-router-dom";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Eye, EyeOff, Copy, Check, Save, X, Ban, SquarePen, Lock, MoreVertical } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface StockItem {
  id: number;
  status: string;
  note: string | null;
  credentials: string;
  createdAtDisplay: string | null;
}

/** Masked preview of an account credential — enough of a prefix to tell rows
 *  apart while screen-sharing, the rest dotted out. The dot run is capped so a
 *  long `email:password:recovery` line can't stretch the column. */
export function maskCredential(value: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "—";
  const visible = trimmed.slice(0, 10);
  const hiddenCount = Math.min(Math.max(trimmed.length - visible.length, 0), 8);
  return visible + "•".repeat(hiddenCount);
}

interface StockProductData {
  product: {
    id: number;
    name: string;
    isActive: boolean;
    broadcastOnRestock: boolean;
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
  const qc = useQueryClient();
  const { data, isError } = useStockProduct(productId ?? "");
  const [credentials, setCredentials] = useState("");
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [activeTab, setActiveTab] = useState<"available" | "sold" | "dead">("available");
  // Only one account is readable at a time — revealing another row hides the
  // previous one, so a shared screen never shows a column of plaintext logins.
  const [revealedId, setRevealedId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [pendingMarkDead, setPendingMarkDead] = useState<StockItem | null>(null);

  function changeTab(tab: string) {
    setActiveTab(tab as typeof activeTab);
    setSelected(new Set());
    setRevealedId(null);
  }

  function copyCredential(item: StockItem) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(item.credentials).then(() => {
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(id => (id === item.id ? null : id)), 1500);
    }).catch(err => {
      console.error("Failed to copy the stock item's account credential to the clipboard", err);
    });
  }

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

  const toggleBroadcast = useMutation({
    mutationFn: (enabled: boolean) =>
      apiPost<{ ok: boolean; broadcastOnRestock: boolean }>(
        `/api/stock/${productId}/broadcast`,
        { enabled },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["stock", productId] }),
  });

  function toggleSelected(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function bulkMarkDead() {
    const count = selected.size;
    setBulkActing(true);
    try {
      await apiPost(`/api/stock/${productId}/bulk-dead`, { ids: Array.from(selected) });
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["stock", productId] });
      toast.success(`${count} item(s) marked dead.`);
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to mark items dead."));
    } finally {
      setBulkActing(false);
    }
  }

  async function bulkDelete() {
    const count = selected.size;
    setBulkActing(true);
    try {
      await apiPost(`/api/stock/${productId}/bulk-delete`, { ids: Array.from(selected) });
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["stock", productId] });
      toast.success(`${count} item(s) deleted.`);
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to delete items."));
    } finally {
      setBulkActing(false);
    }
  }

  async function markItemDead(id: number) {
    try {
      await apiPost(`/api/stock/item/${id}/dead`, {});
      await qc.invalidateQueries({ queryKey: ["stock", productId] });
      toast.success("Stock item marked dead.");
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to mark item dead."));
    }
  }

  async function saveNote(id: number) {
    try {
      await apiPost(`/api/stock/item/${id}/note`, { note: noteDraft });
      setEditingNoteId(null);
      await qc.invalidateQueries({ queryKey: ["stock", productId] });
      toast.success("Note saved.");
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to update note."));
    }
  }

  function renderStockTable(tabItems: StockItem[]) {
    return (
      <>
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
                <Checkbox
                  checked={selected.has(item.id)}
                  onCheckedChange={() => toggleSelected(item.id)}
                  aria-label={`Select stock item ${item.id}`}
                />
              ),
            },
            { key: "id", header: "#", render: item => <span className="font-mono text-xs text-ink-soft">{item.id}</span> },
            { key: "status", header: "Status", render: item => <StatusBadge status={item.status} /> },
            {
              key: "credentials",
              header: (
                <span className="inline-flex items-center gap-1">
                  <Lock className="h-3.5 w-3.5 text-ink-faint" />
                  Account
                </span>
              ),
              render: item => {
                const revealed = revealedId === item.id;
                return (
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-xs text-ink break-all">
                      {revealed ? (item.credentials || "—") : maskCredential(item.credentials)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={
                        revealed
                          ? `Hide account for stock item ${item.id}`
                          : `Show account for stock item ${item.id}`
                      }
                      onClick={() => setRevealedId(id => (id === item.id ? null : item.id))}
                    >
                      {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Copy account for stock item ${item.id}`}
                      onClick={() => copyCredential(item)}
                    >
                      {copiedId === item.id
                        ? <Check className="h-3.5 w-3.5 text-grass" />
                        : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                );
              },
            },
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
                    <Button size="sm" variant="ghost" onClick={() => void saveNote(item.id)}><Save className="h-4 w-4" />Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingNoteId(null)}><X className="h-4 w-4" />Cancel</Button>
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
                <div onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for stock item ${item.id}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => { setEditingNoteId(item.id); setNoteDraft(item.note ?? ""); }}>
                        <SquarePen className="h-4 w-4" />
                        Edit Note
                      </DropdownMenuItem>
                      {item.status !== "DEAD" && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={(e) => { e.preventDefault(); setPendingMarkDead(item); }}
                          >
                            <Ban className="h-4 w-4" />
                            Mark Dead
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ),
            },
          ]}
          data={tabItems}
          keyExtractor={item => item.id}
          empty={<EmptyState title="No stock items" description="Add credentials above to stock this denomination." />}
        />
      </>
    );
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
  const availableItems = items.filter(i => i.status === "AVAILABLE");
  const soldItems = items.filter(i => i.status === "SOLD" || i.status === "RESERVED");
  const deadItems = items.filter(i => i.status === "DEAD");

  return (
    <PageLayout title={product.name}>
      <PageHeader
        title={product.name}
        breadcrumb={[{ label: "Stock", href: "/stock" }]}
        actions={
          activeTab === "available" ? (
            <a href={`/api/stock/${productId}/download`}>
              <Button variant="outline" size="sm">Download credentials</Button>
            </a>
          ) : undefined
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
          <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
            <Checkbox
              checked={product.broadcastOnRestock}
              onCheckedChange={(checked) => toggleBroadcast.mutate(checked === true)}
              aria-label="Broadcast to all customers when I add stock to this product"
            />
            Broadcast to all customers when I add stock to this product
          </label>
        </CardContent>
      </Card>

      {/* Items table, grouped by status */}
      <h2 className="text-sm font-semibold text-ink mb-3">Stock Items ({items.length})</h2>

      <Tabs value={activeTab} onValueChange={changeTab}>
        <TabsList>
          <TabsTrigger value="available">Available ({availableItems.length})</TabsTrigger>
          <TabsTrigger value="sold">Sold ({soldItems.length})</TabsTrigger>
          <TabsTrigger value="dead">Dead ({deadItems.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="available">
          {renderStockTable(availableItems)}
        </TabsContent>
        <TabsContent value="sold">
          {renderStockTable(soldItems)}
        </TabsContent>
        <TabsContent value="dead">
          {renderStockTable(deadItems)}
        </TabsContent>
      </Tabs>

      {pendingMarkDead && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setPendingMarkDead(null); }}
          title="Mark this stock item dead?"
          description={`Mark stock item #${pendingMarkDead.id} dead. This removes it from availability.`}
          confirmLabel="Mark Dead"
          onConfirm={() => markItemDead(pendingMarkDead.id)}
        />
      )}
    </PageLayout>
  );
}
