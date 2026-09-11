import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Pagination } from "../components/shared/Pagination";
import { SearchBar } from "../components/shared/SearchBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Eye, EyeOff, Copy, Check, Save, X, Ban, SquarePen, Lock, MoreVertical, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { apiGet, apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";
import { visibleSelection } from "../lib/selection";

interface StockItem {
  id: number;
  status: string;
  note: string | null;
  /** Always the server's constant mask placeholder — StockItem.credentials is
   *  encrypted at rest and this list payload never carries a decrypted value.
   *  The real credential is fetched per-row, on demand, via the reveal
   *  mutation below (POST /api/stock/item/:id/reveal), which the server
   *  audits as credential_revealed every time it's called. */
  credentials: string;
  createdAtDisplay: string | null;
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
  statusCounts: { available: number; reserved: number; sold: number; dead: number };
  total: number;
  waiting: number;
}

// Must match the server's PAGE_SIZE in apps/web-admin/src/routes/api/stock.ts.
const PAGE_SIZE = 50;

function useStockProduct(productId: string, tab: string, page: number, search: string) {
  return useQuery<StockProductData>({
    queryKey: ["stock", productId, tab, page, search],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("tab", tab);
      if (search) params.set("q", search);
      else params.set("page", String(page));
      return apiGet<StockProductData>(`/api/stock/${productId}?${params.toString()}`);
    },
    enabled: !!productId,
    // Keeps the previously-loaded tab's rows on screen while the new tab's
    // page is fetched, instead of unmounting the whole table (and the tab
    // bar with it) back to the top-level "Loading…" state on every switch.
    placeholderData: keepPreviousData,
    // Every mutation on this page explicitly invalidates ["stock", productId]
    // (which forces a refetch regardless of staleness), so a short staleTime
    // here only avoids a redundant network round-trip when an admin flips
    // back and forth between tabs they've already loaded — it doesn't risk
    // showing outdated data after an actual change.
    staleTime: 15_000,
  });
}

export function StockProductPage() {
  const { productId } = useParams<{ productId: string }>();
  const qc = useQueryClient();
  const [credentials, setCredentials] = useState("");
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [activeTab, setActiveTab] = useState<"available" | "sold" | "dead">("available");
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState(""); // committed/submitted query — drives the fetch
  const { data, isError } = useStockProduct(productId ?? "", activeTab, page, search);
  // Only one account is readable at a time — revealing another row hides the
  // previous one, so a shared screen never shows a column of plaintext logins.
  // `revealedText` is fetched fresh from the server (never derived from the
  // list payload, which only ever carries the masked placeholder) — every
  // fetch is an explicit, server-audited credential_revealed action.
  const [revealedId, setRevealedId] = useState<number | null>(null);
  const [revealedText, setRevealedText] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [pendingMarkDead, setPendingMarkDead] = useState<StockItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StockItem | null>(null);

  function changeTab(tab: string) {
    setActiveTab(tab as typeof activeTab);
    setSelected(new Set());
    setRevealedId(null);
    setRevealedText(null);
    setPage(1);
    setSearch("");
    setSearchDraft("");
  }

  async function fetchRevealed(item: StockItem): Promise<string> {
    const result = await apiPost<{ ok: boolean; credentials: string | null }>(
      `/api/stock/item/${item.id}/reveal`,
      {},
    );
    const text = result.credentials ?? "";
    setRevealedId(item.id);
    setRevealedText(text);
    return text;
  }

  function toggleReveal(item: StockItem) {
    if (revealedId === item.id) {
      setRevealedId(null);
      setRevealedText(null);
      return;
    }
    fetchRevealed(item).catch((e: unknown) => {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to reveal the account credential."));
    });
  }

  async function copyCredential(item: StockItem) {
    if (!navigator.clipboard) return;
    try {
      const text = revealedId === item.id && revealedText != null ? revealedText : await fetchRevealed(item);
      await navigator.clipboard.writeText(text);
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(id => (id === item.id ? null : id)), 1500);
    } catch (err) {
      console.error("Failed to copy the stock item's account credential to the clipboard", err);
      toast.error(describeError(err instanceof Error ? err.message : "Failed to copy the account credential."));
    }
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
    // Optimistic flip: this is a single boolean on an otherwise-static page,
    // so ticking it shouldn't wait on a POST round-trip or pay for a refetch
    // of a full page of the stock payload (PAGE_SIZE rows, credential-bearing).
    // Cancel any in-flight refetch first so it can't race the optimistic
    // write and clobber it with stale data.
    //
    // The query key now carries tab/page/search (["stock", productId, tab,
    // page, search]), so a plain setQueryData/getQueryData against the bare
    // ["stock", productId] key would silently no-op. setQueriesData/
    // getQueriesData match by key *prefix*, patching every cached tab/page/
    // search combination for this product at once.
    onMutate: async (enabled): Promise<{ previous: [readonly unknown[], StockProductData | undefined][] }> => {
      await qc.cancelQueries({ queryKey: ["stock", productId] });
      const previous = qc.getQueriesData<StockProductData>({ queryKey: ["stock", productId] });
      qc.setQueriesData<StockProductData>({ queryKey: ["stock", productId] }, (old) =>
        old ? { ...old, product: { ...old.product, broadcastOnRestock: enabled } } : old,
      );
      return { previous };
    },
    onError: (err: Error, _enabled, ctx) => {
      // `previous` entries with undefined data are deliberate no-ops when
      // restored — setQueryData with undefined leaves that cache slot empty,
      // matching what onMutate found there before the optimistic write.
      if (ctx) {
        ctx.previous.forEach(([key, snapshot]) => qc.setQueryData(key, snapshot));
      }
      toast.error(describeError(err.message));
    },
    // Patch with the server's authoritative value instead of invalidating —
    // this toggle doesn't change anything else on the page worth refetching.
    onSuccess: (result) => {
      qc.setQueriesData<StockProductData>({ queryKey: ["stock", productId] }, (old) =>
        old ? { ...old, product: { ...old.product, broadcastOnRestock: result.broadcastOnRestock } } : old,
      );
    },
  });

  function toggleSelected(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function toggleSelectAllInTab(items: StockItem[]) {
    setSelected((prev) => {
      // Drops everything rather than pruning visible ids: a refetch can remove a row
      // with no tab change, and pruning would strand its id in the selection.
      const allSelected = items.length > 0 && items.every((i) => prev.has(i.id));
      if (allSelected) return new Set();
      const next = new Set(prev);
      items.forEach((i) => next.add(i.id));
      return next;
    });
  }

  // Takes an explicit `ids` argument rather than reading `selected` from
  // closure: selection is per-tab, and only the caller inside renderStockTable
  // knows which tab's items are on screen.
  async function bulkMarkDead(ids: number[]) {
    const count = ids.length;
    setBulkActing(true);
    try {
      await apiPost(`/api/stock/${productId}/bulk-dead`, { ids });
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["stock", productId] });
      toast.success(`${count} item(s) marked dead.`);
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to mark items dead."));
    } finally {
      setBulkActing(false);
    }
  }

  async function bulkDelete(ids: number[]) {
    setBulkActing(true);
    try {
      const result = await apiPost<{ ok: boolean; count: number; skipped: number }>(
        `/api/stock/${productId}/bulk-delete`,
        { ids },
      );
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["stock", productId] });
      toast.success(
        result.skipped === 0
          ? `${result.count} item(s) deleted.`
          : `${result.count} item(s) deleted. ${result.skipped} skipped (sold or linked to an order).`,
      );
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

  async function deleteItem(id: number) {
    try {
      await apiPost(`/api/stock/item/${id}/delete`, {});
      await qc.invalidateQueries({ queryKey: ["stock", productId] });
      toast.success("Stock item deleted.");
    } catch (e) {
      toast.error(describeError(e instanceof Error ? e.message : "Failed to delete item."));
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
    // Scoped to this tab's items: marking an item dead moves it out of the
    // Available tab while it stays in `items`, so a selection made here must
    // not keep counting it once it has gone.
    const visibleSelected = visibleSelection(selected, tabItems, (i) => i.id);
    return (
      <>
        {visibleSelected.size > 0 && (
          <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
            <span className="text-ink-soft">{visibleSelected.size} selected</span>
            <ConfirmDialog
              trigger={<Button size="sm" variant="destructive" disabled={bulkActing}>Mark selected dead</Button>}
              title="Mark selected stock items dead?"
              description={`Mark ${visibleSelected.size} stock item(s) dead. This removes them from availability.`}
              confirmLabel="Mark Dead"
              onConfirm={() => bulkMarkDead(Array.from(visibleSelected))}
            />
            <ConfirmDialog
              trigger={<Button size="sm" variant="destructive" disabled={bulkActing}>Delete</Button>}
              title="Delete selected stock items?"
              description={`Delete ${visibleSelected.size} stock item(s). Sold items or items tied to an order are skipped.`}
              confirmLabel="Delete"
              onConfirm={() => bulkDelete(Array.from(visibleSelected))}
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
              kind: "selection",
              header: (
                <Checkbox
                  checked={tabItems.length > 0 && tabItems.every((i) => selected.has(i.id))}
                  onCheckedChange={() => toggleSelectAllInTab(tabItems)}
                  aria-label="Select all stock items on this page"
                />
              ),
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
                      {revealed ? (revealedText || "—") : item.credentials}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={
                        revealed
                          ? `Hide account for stock item ${item.id}`
                          : `Show account for stock item ${item.id}`
                      }
                      onClick={() => toggleReveal(item)}
                    >
                      {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Copy account for stock item ${item.id}`}
                      onClick={() => void copyCredential(item)}
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
                  <span
                    className="block max-w-[240px] truncate text-xs text-ink-soft"
                    title={item.note ?? undefined}
                  >
                    {item.note ?? "—"}
                  </span>
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
                      {item.status !== "SOLD" && (
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={(e) => { e.preventDefault(); setPendingDelete(item); }}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
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

  const { product, items, statusCounts, waiting, total } = data;

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
        <span className="text-ink-soft">Available: <span className="font-semibold text-ink">{statusCounts.available}</span></span>
        <span className="text-ink-soft">Waiting: <span className="text-ink">{waiting}</span></span>
      </div>

      {/* Bulk add */}
      <Card className="mb-6">
        <CardHeader><CardTitle>Bulk Add Credentials</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {bulkMsg && <p className="text-sm text-grass">{bulkMsg}</p>}
          {bulkError && <p className="text-sm text-rust">{bulkError}</p>}
          <Textarea
            aria-label="Credentials, one per line"
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
              disabled={toggleBroadcast.isPending}
              aria-label="Broadcast to all customers when I add stock to this product"
            />
            Broadcast to all customers when I add stock to this product
          </label>
        </CardContent>
      </Card>

      {/* Items table, grouped by status */}
      <h2 className="text-sm font-semibold text-ink mb-3">Stock Items</h2>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBar
          value={searchDraft}
          onChange={setSearchDraft}
          onSearch={() => { setSearch(searchDraft); setPage(1); }}
          placeholder="Search this tab's accounts…"
        />
        {search && (
          <>
            <span className="text-sm text-ink-soft">
              Showing {total} result{total === 1 ? "" : "s"} for &quot;{search}&quot;
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setSearch(""); setSearchDraft(""); setPage(1); }}
            >
              Clear
            </Button>
          </>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={changeTab}>
        <TabsList>
          <TabsTrigger value="available">Available ({statusCounts.available})</TabsTrigger>
          <TabsTrigger value="sold">Sold ({statusCounts.sold + statusCounts.reserved})</TabsTrigger>
          <TabsTrigger value="dead">Dead ({statusCounts.dead})</TabsTrigger>
        </TabsList>
        <TabsContent value="available">
          {renderStockTable(items)}
        </TabsContent>
        <TabsContent value="sold">
          {renderStockTable(items)}
        </TabsContent>
        <TabsContent value="dead">
          {renderStockTable(items)}
        </TabsContent>
      </Tabs>

      {/* Search results aren't paginated server-side (Task 2) — hide the
          pagination control while a search is active. */}
      {!search && (
        <div className="mt-4">
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </div>
      )}

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

      {pendingDelete && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
          title="Delete this stock item?"
          description={`Delete stock item #${pendingDelete.id}. This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => deleteItem(pendingDelete.id)}
        />
      )}
    </PageLayout>
  );
}
