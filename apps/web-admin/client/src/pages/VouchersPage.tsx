import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Check,
  Tag,
  Plus,
  X,
  Trash2,
  CheckCircle2,
  Ban,
  CalendarClock,
  Repeat,
  MoreVertical,
  Eye,
  Pencil,
  CopyPlus,
} from "lucide-react";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { StatCard } from "../components/shared/StatCard";
import { Pagination } from "../components/shared/Pagination";
import { ProgressBar } from "../components/shared/ProgressBar";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { Button } from "@/components/ui/button";
import { DateInput } from "../components/shared/DateInput";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "../components/shared/StatusBadge";
import { toast } from "sonner";
import { apiGet, apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface VoucherProductRef {
  id: number;
  name: string;
}

type VoucherStatus = "active" | "expired" | "usedUp" | "disabled" | "scheduled";

interface Voucher {
  id: number;
  code: string;
  type: string;
  value: string;
  isActive: boolean;
  usageLimit: number | null;
  usedCount: number;
  minPurchase: string;
  expiresAt: string | null;
  expiresAtDisplay: string | null;
  scope: "ALL" | "SELECTED";
  maxDiscount: string | null;
  startAt: string | null;
  products: VoucherProductRef[];
  status: VoucherStatus;
  ordersCount: number;
  revenue: string;
  customers: number;
}

interface CatalogProduct {
  id: number;
  name: string;
  categoryId: number;
  isActive: boolean;
  isArchived: boolean;
}
interface CatalogCategory {
  id: number;
  name: string;
}
interface CatalogData {
  categories: CatalogCategory[];
  products: CatalogProduct[];
}

interface VoucherFormState {
  code: string;
  type: string;
  value: string;
  min_purchase: string;
  usage_limit: string;
  expires_at: string;
  max_discount: string;
  start_at: string;
  scope: "ALL" | "SELECTED";
  product_ids: number[];
}

const EMPTY_FORM: VoucherFormState = {
  code: "",
  type: "PERCENT",
  value: "",
  min_purchase: "",
  usage_limit: "",
  expires_at: "",
  max_discount: "",
  start_at: "",
  scope: "ALL",
  product_ids: [],
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Server-sent `status` is lowerCamelCase ("usedUp"); StatusBadge's tone map
 *  keys are SCREAMING_SNAKE_CASE and, for the used-up case specifically, a
 *  different word entirely ("USAGE_LIMIT_REACHED") — every other status is a
 *  plain uppercase of the server value, so only that one case needs a
 *  lookup instead of a bare `.toUpperCase()`. */
function voucherStatusToneKey(status: VoucherStatus): string {
  if (status === "usedUp") return "USAGE_LIMIT_REACHED";
  return status.toUpperCase();
}

function discountPrimary(v: Voucher): string {
  return v.type === "PERCENT" ? `${v.value}%` : `${formatCurrencyDisplay(v.value, "IDR")} Off`;
}

function discountSecondary(v: Voucher): string | null {
  const parts: string[] = [];
  if (Number(v.minPurchase) > 0) parts.push(`Min ${formatCurrencyDisplay(v.minPurchase, "IDR")}`);
  if (v.maxDiscount != null) parts.push(`Max ${formatCurrencyDisplay(v.maxDiscount, "IDR")}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function usagePrimary(v: Voucher): string {
  return v.usageLimit == null ? "Unlimited" : `${v.usedCount}/${v.usageLimit}`;
}

/** Precedence mirrors the server's own `deriveVoucherStatus` (packages/db/src/
 *  crud/vouchers.ts): an already-expired date always wins, and the "expires
 *  soon" countdown only applies to a voucher the server still calls "active"
 *  (a used-up/disabled/scheduled voucher expiring in 3 days isn't usefully
 *  described as "expiring soon" — it's already unusable for a different
 *  reason). */
function expirationCell(v: Voucher, now: Date): { text: string; muted: boolean } {
  if (!v.expiresAt) return { text: "No expiry", muted: false };
  const expiryTime = new Date(v.expiresAt).getTime();
  if (expiryTime < now.getTime()) return { text: "Expired", muted: true };
  const daysLeft = Math.ceil((expiryTime - now.getTime()) / MS_PER_DAY);
  if (v.status === "active" && daysLeft <= 7) {
    return { text: `Expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`, muted: false };
  }
  return { text: `Ends ${v.expiresAtDisplay ?? ""}`, muted: false };
}

/** Shared request body builder for both `POST /api/vouchers` (create) and
 *  `POST /api/vouchers/:id/update` — the two routes accept an identical
 *  field set, so Create/Edit/Duplicate can all build their request body the
 *  same way. `product_ids` is always sent explicitly (either the current
 *  selection, or `[]` for ALL scope) — see the update route's doc comment on
 *  why an *omitted* `product_ids` (not the same as an empty array) is
 *  reserved for "leave the existing product set untouched", which never
 *  applies to a full-form submission like this one. */
function voucherRequestBody(form: VoucherFormState): Record<string, unknown> {
  return {
    code: form.code,
    type: form.type,
    value: form.value,
    min_purchase: form.min_purchase,
    usage_limit: form.usage_limit,
    expires_at: form.expires_at,
    max_discount: form.max_discount,
    start_at: form.start_at,
    scope: form.scope,
    product_ids: form.scope === "SELECTED" ? form.product_ids : [],
  };
}

function useVouchers(q: string, status: string, page: number) {
  return useQuery<{
    vouchers: Voucher[];
    types: string[];
    scopes: string[];
    total: number;
    page: number;
    pageSize: number;
    stats: { active: number; scheduled: number; expired: number; totalRedemptions: number };
  }>({
    queryKey: ["vouchers", q, status, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page) });
      if (q) params.set("q", q);
      if (status) params.set("status", status);
      const res = await fetch(`/api/vouchers?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });
}

function useCatalog() {
  return useQuery<CatalogData>({
    queryKey: ["catalog"],
    queryFn: () => apiGet<CatalogData>("/api/catalog"),
    staleTime: 60_000,
  });
}

/**
 * Page-local product-scope picker for the voucher form's Scope=SELECTED
 * case. Not a `components/shared/*` component per the task brief — this is
 * the only page that scopes a discount to a product subset today. Filters
 * out archived/inactive products by default, but keeps a product that's
 * already selected on the voucher being edited visible (and deselectable)
 * even if it's since been archived — otherwise editing a voucher whose scope
 * includes a since-archived product would silently drop it from the list
 * with no way to see or intentionally remove it.
 */
function ProductScopePicker({
  selectedIds,
  onChange,
}: {
  selectedIds: number[];
  onChange: (ids: number[]) => void;
}) {
  const { data, isLoading } = useCatalog();
  const [filter, setFilter] = useState("");
  const products = data?.products ?? [];
  const categories = data?.categories ?? [];

  const pickable = products.filter((p) => (p.isActive && !p.isArchived) || selectedIds.includes(p.id));
  const filtered = pickable.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));

  const byCategory = new Map<number, CatalogProduct[]>();
  for (const p of filtered) {
    const list = byCategory.get(p.categoryId) ?? [];
    list.push(p);
    byCategory.set(p.categoryId, list);
  }

  function toggle(id: number) {
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-56 justify-start font-normal">
          {selectedIds.length > 0
            ? `${selectedIds.length} product${selectedIds.length === 1 ? "" : "s"} selected`
            : "Select products"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="start">
        <Input
          placeholder="Search products..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Search products"
        />
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {isLoading && <p className="px-1 py-2 text-sm text-ink-soft">Loading products...</p>}
          {!isLoading && filtered.length === 0 && (
            <p className="px-1 py-2 text-sm text-ink-soft">No products found.</p>
          )}
          {categories
            .filter((c) => byCategory.has(c.id))
            .map((c) => (
              <div key={c.id}>
                <div className="mb-1 text-xs font-semibold tracking-wider text-ink-soft uppercase">{c.name}</div>
                <div className="flex flex-col gap-1">
                  {(byCategory.get(c.id) ?? []).map((p) => (
                    <label
                      key={p.id}
                      className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-sand"
                    >
                      <Checkbox checked={selectedIds.includes(p.id)} onCheckedChange={() => toggle(p.id)} />
                      {p.name}
                      {p.isArchived && <span className="text-xs text-ink-soft">(archived)</span>}
                    </label>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function VouchersPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<VoucherFormState>(EMPTY_FORM);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [qDraft, setQDraft] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<Voucher | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Voucher | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => { setQ(qDraft); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [qDraft]);
  const { data, isError } = useVouchers(q, status, page);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => { setSelected(new Set()); }, [q, status, page]);

  const vouchers = data?.vouchers ?? [];
  const allSelected = vouchers.length > 0 && vouchers.every(v => selected.has(v.id));

  function toggleSelected(id: number) {
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleSelectAll() {
    setSelected(prev => {
      const next = new Set(prev);
      if (allSelected) {
        vouchers.forEach(v => next.delete(v.id));
      } else {
        vouchers.forEach(v => next.add(v.id));
      }
      return next;
    });
  }

  function handleCopy(v: Voucher) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(v.code).then(() => {
      setCopiedId(v.id);
      setTimeout(() => setCopiedId(id => (id === v.id ? null : id)), 1500);
    }).catch(err => {
      console.error("Failed to copy voucher code to clipboard", err);
    });
  }

  function closeForm() {
    setShowForm(false);
    setMode("create");
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function openCreateForm() {
    setMode("create");
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEditForm(v: Voucher) {
    setMode("edit");
    setEditingId(v.id);
    setForm({
      code: v.code,
      type: v.type,
      value: v.value,
      min_purchase: v.minPurchase,
      usage_limit: v.usageLimit != null ? String(v.usageLimit) : "",
      expires_at: v.expiresAt ? v.expiresAt.slice(0, 10) : "",
      max_discount: v.maxDiscount ?? "",
      start_at: v.startAt ? v.startAt.slice(0, 10) : "",
      scope: v.scope,
      product_ids: v.products.map(p => p.id),
    });
    setShowForm(true);
  }

  function openDuplicateForm(v: Voucher) {
    setMode("create");
    setEditingId(null);
    setForm({
      code: "",
      type: v.type,
      value: v.value,
      min_purchase: v.minPurchase,
      usage_limit: v.usageLimit != null ? String(v.usageLimit) : "",
      expires_at: v.expiresAt ? v.expiresAt.slice(0, 10) : "",
      max_discount: v.maxDiscount ?? "",
      start_at: v.startAt ? v.startAt.slice(0, 10) : "",
      scope: v.scope,
      product_ids: v.products.map(p => p.id),
    });
    setShowForm(true);
  }

  const create = useMutation({
    mutationFn: (body: VoucherFormState) => apiPost("/api/vouchers", voucherRequestBody(body)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["vouchers"] });
      closeForm();
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const update = useMutation({
    mutationFn: ({ id, form: f }: { id: number; form: VoucherFormState }) =>
      apiPost(`/api/vouchers/${id}/update`, voucherRequestBody(f)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["vouchers"] });
      closeForm();
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiPost(`/api/vouchers/${id}/toggle`, { is_active: active ? "1" : "0" }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["vouchers"] });
      toast.success(vars.active ? "Voucher enabled." : "Voucher disabled.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const del = useMutation({
    mutationFn: (id: number) => apiPost(`/api/vouchers/${id}/delete`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["vouchers"] });
      toast.success("Voucher deleted.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const bulkAction = useMutation({
    mutationFn: (vars: { ids: number[]; action: "activate" | "deactivate" | "delete" }) =>
      apiPost<{ succeeded: number[]; failed: { id: number; error: string }[] }>("/api/vouchers/bulk-action", vars),
    onSuccess: (result, vars) => {
      void qc.invalidateQueries({ queryKey: ["vouchers"] });
      setSelected(new Set());
      const verb = vars.action === "activate" ? "Activated" : vars.action === "deactivate" ? "Deactivated" : "Deleted";
      toast.success(
        result.failed.length > 0
          ? `${verb} ${result.succeeded.length} of ${vars.ids.length} vouchers — ${result.failed.length} skipped.`
          : `${verb} ${result.succeeded.length} voucher${result.succeeded.length === 1 ? "" : "s"}.`,
      );
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  if (isError) return <PageLayout title="Vouchers"><p className="text-sm text-rust">Failed to load vouchers.</p></PageLayout>;

  const now = new Date();

  return (
    <PageLayout title="Vouchers">
      <PageHeader
        title="Vouchers"
        description="Create and manage discount codes."
        actions={
          <Button onClick={() => (showForm ? closeForm() : openCreateForm())}>
            {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {showForm ? "Cancel" : "New Voucher"}
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Active" value={data?.stats.active ?? 0} icon={CheckCircle2} tone="success" isLoading={!data} />
        <StatCard label="Scheduled" value={data?.stats.scheduled ?? 0} icon={CalendarClock} tone="warning" isLoading={!data} />
        <StatCard label="Expired" value={data?.stats.expired ?? 0} icon={Ban} isLoading={!data} />
        <StatCard label="Total Redemptions" value={data?.stats.totalRedemptions ?? 0} icon={Repeat} isLoading={!data} />
      </div>

      {showForm && (
        <Card className="mb-6">
          <CardHeader><CardTitle>{mode === "edit" ? "Edit Voucher" : "New Voucher"}</CardTitle></CardHeader>
          <CardContent>
            <form
              onSubmit={e => {
                e.preventDefault();
                if (mode === "edit" && editingId != null) update.mutate({ id: editingId, form });
                else create.mutate(form);
              }}
              className="flex flex-wrap items-start gap-3"
            >
              <div className="flex flex-col gap-1">
                <label htmlFor="voucher-code" className="text-xs font-medium text-ink">
                  Code <span className="text-rust">*</span>
                </label>
                <Input
                  id="voucher-code"
                  required
                  placeholder="e.g. SAVE10"
                  value={form.code}
                  onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
                  className="w-32"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="voucher-type" className="text-xs font-medium text-ink">
                  Type <span className="text-rust">*</span>
                </label>
                <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v }))}>
                  <SelectTrigger id="voucher-type" className="w-32" aria-label="Type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(data?.types ?? ["PERCENT", "FIXED"]).map(t => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="voucher-value" className="text-xs font-medium text-ink">
                  Value <span className="text-rust">*</span>
                </label>
                <Input
                  id="voucher-value"
                  required
                  placeholder="e.g. 10"
                  value={form.value}
                  onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                  className="w-24"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="voucher-min-purchase" className="text-xs font-medium text-ink">
                  Min purchase
                </label>
                <Input
                  id="voucher-min-purchase"
                  placeholder="Optional"
                  value={form.min_purchase}
                  onChange={e => setForm(f => ({ ...f, min_purchase: e.target.value }))}
                  className="w-28"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="voucher-max-discount" className="text-xs font-medium text-ink">
                  Max discount
                </label>
                <Input
                  id="voucher-max-discount"
                  placeholder="Optional"
                  value={form.max_discount}
                  onChange={e => setForm(f => ({ ...f, max_discount: e.target.value }))}
                  className="w-28"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="voucher-usage-limit" className="text-xs font-medium text-ink">
                  Usage limit
                </label>
                <Input
                  id="voucher-usage-limit"
                  placeholder="Optional"
                  value={form.usage_limit}
                  onChange={e => setForm(f => ({ ...f, usage_limit: e.target.value }))}
                  className="w-28"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="voucher-start" className="text-xs font-medium text-ink">
                  Starts
                </label>
                <DateInput
                  id="voucher-start"
                  placeholder="Optional"
                  value={form.start_at}
                  onChange={e => setForm(f => ({ ...f, start_at: e.target.value }))}
                  className="w-36"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="voucher-expires" className="text-xs font-medium text-ink">
                  Expires
                </label>
                <DateInput
                  id="voucher-expires"
                  placeholder="Optional"
                  value={form.expires_at}
                  onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))}
                  className="w-36"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="voucher-scope" className="text-xs font-medium text-ink">
                  Scope
                </label>
                <Select
                  value={form.scope}
                  onValueChange={v => setForm(f => ({
                    ...f,
                    scope: v as "ALL" | "SELECTED",
                    product_ids: v === "ALL" ? [] : f.product_ids,
                  }))}
                >
                  <SelectTrigger id="voucher-scope" className="w-40" aria-label="Scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(data?.scopes ?? ["ALL", "SELECTED"]).map(s => (
                      <SelectItem key={s} value={s}>{s === "ALL" ? "All Products" : "Selected Products"}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {form.scope === "SELECTED" && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-ink">Products</label>
                  <ProductScopePicker
                    selectedIds={form.product_ids}
                    onChange={ids => setForm(f => ({ ...f, product_ids: ids }))}
                  />
                </div>
              )}
              <Button type="submit" disabled={create.isPending || update.isPending} className="self-end">
                {mode === "edit"
                  ? (update.isPending ? "Saving…" : "Save Changes")
                  : (create.isPending ? "Creating…" : "Create")}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <FilterBar className="mb-4">
        <SearchBar
          value={qDraft}
          onChange={setQDraft}
          placeholder="Search voucher code..."
          className="w-full sm:w-64"
        />
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Status</label>
          <Select
            value={status || "_all_"}
            onValueChange={v => { setStatus(v === "_all_" ? "" : v); setPage(1); }}
          >
            <SelectTrigger className="w-40"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="scheduled">Scheduled</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="usedUp">Used up</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </FilterBar>

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
          <span className="text-ink-soft">{selected.size} selected</span>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkAction.isPending}
            onClick={() => bulkAction.mutate({ ids: Array.from(selected), action: "activate" })}
          >
            Activate {selected.size} voucher{selected.size === 1 ? "" : "s"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkAction.isPending}
            onClick={() => bulkAction.mutate({ ids: Array.from(selected), action: "deactivate" })}
          >
            Deactivate {selected.size} voucher{selected.size === 1 ? "" : "s"}
          </Button>
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="destructive" disabled={bulkAction.isPending}>
                Delete {selected.size} voucher{selected.size === 1 ? "" : "s"}
              </Button>
            }
            title={`Delete ${selected.size} voucher${selected.size === 1 ? "" : "s"}?`}
            description="Vouchers that have already been used are skipped, not deleted."
            confirmLabel="Delete"
            onConfirm={() => bulkAction.mutate({ ids: Array.from(selected), action: "delete" })}
          />
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <DataTable
        columns={[
          {
            key: "select",
            header: (
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleSelectAll}
                disabled={vouchers.length === 0}
                aria-label="Select all vouchers"
              />
            ),
            render: v => (
              <Checkbox
                checked={selected.has(v.id)}
                onCheckedChange={() => toggleSelected(v.id)}
                onClick={e => e.stopPropagation()}
                aria-label={`Select voucher ${v.code}`}
              />
            ),
          },
          {
            key: "voucher",
            header: "Voucher",
            render: v => (
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-sm">{v.code}</span>
                  <button
                    type="button"
                    onClick={() => handleCopy(v)}
                    aria-label={`Copy code ${v.code}`}
                    className="text-ink-soft transition-colors hover:text-ink"
                  >
                    {copiedId === v.id
                      ? <Check className="h-3.5 w-3.5 text-grass-dark" />
                      : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <span className="text-xs text-ink-soft">
                  {v.type === "PERCENT" ? "Percent off" : "Fixed amount off"}
                </span>
              </div>
            ),
          },
          {
            key: "discount",
            header: "Discount",
            render: v => {
              const secondary = discountSecondary(v);
              return (
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-sm">{discountPrimary(v)}</span>
                  {secondary && <span className="text-xs text-ink-soft">{secondary}</span>}
                </div>
              );
            },
          },
          {
            key: "usage",
            header: "Usage",
            render: v => {
              const pct = v.usageLimit != null ? (v.usedCount / v.usageLimit) * 100 : 0;
              const tone = pct < 50 ? "grass" : pct < 85 ? "amberx" : "rust";
              return (
                <div className="flex min-w-[100px] flex-col gap-1">
                  <span className="text-sm">{usagePrimary(v)}</span>
                  {v.usageLimit != null && <ProgressBar value={pct} tone={tone} />}
                </div>
              );
            },
          },
          {
            key: "expiration",
            header: "Expiration",
            render: v => {
              const { text, muted } = expirationCell(v, now);
              return <span className={`text-sm ${muted ? "text-ink-soft" : "text-ink"}`}>{text}</span>;
            },
          },
          {
            key: "status",
            header: "Status",
            render: v => <StatusBadge status={voucherStatusToneKey(v.status)} />,
          },
          {
            key: "scope",
            header: "Scope",
            render: v => {
              if (v.scope === "ALL") return <span className="text-sm text-ink-soft">All Products</span>;
              const shown = v.products.slice(0, 2);
              const extra = v.products.length - shown.length;
              return (
                <div className="flex flex-wrap gap-1">
                  {shown.map(p => <Badge key={p.id} variant="default">{p.name}</Badge>)}
                  {extra > 0 && <Badge variant="default">+{extra} more</Badge>}
                </div>
              );
            },
          },
          {
            key: "performance",
            header: "Performance",
            render: v => (
              <div className="flex flex-col gap-0.5">
                <span className="text-sm">{v.ordersCount} orders</span>
                <span className="text-xs text-ink-soft">
                  {formatCurrencyDisplay(v.revenue, "IDR")} · {v.customers} customers
                </span>
              </div>
            ),
          },
          {
            key: "actions",
            header: "",
            render: v => (
              <div onClick={e => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${v.code}`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setViewing(v)}>
                      <Eye className="h-4 w-4" />
                      View
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openEditForm(v)}>
                      <Pencil className="h-4 w-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openDuplicateForm(v)}>
                      <CopyPlus className="h-4 w-4" />
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => toggle.mutate({ id: v.id, active: !v.isActive })}>
                      {v.isActive ? <Ban className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                      {v.isActive ? "Disable" : "Enable"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={e => { e.preventDefault(); setPendingDelete(v); }}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ),
          },
        ]}
        data={vouchers}
        isLoading={!data}
        keyExtractor={v => v.id}
        empty={
          status || q
            ? <EmptyState icon={Tag} title="No matching vouchers" description="Try a different search or status filter." />
            : <EmptyState icon={Tag} title="No vouchers found" description="Create your first voucher to offer discounts." />
        }
      />

      {data && (
        <div className="mt-4">
          <Pagination
            page={page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={setPage}
          />
        </div>
      )}

      {viewing && (
        <Dialog open onOpenChange={open => { if (!open) setViewing(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-mono">{viewing.code}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4 text-sm">
              <div className="flex items-center justify-between">
                <StatusBadge status={voucherStatusToneKey(viewing.status)} />
                <span className="text-xs text-ink-soft">
                  {viewing.type === "PERCENT" ? "Percent off" : "Fixed amount off"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-ink-soft">Discount</div>
                  <div className="font-medium text-ink">{discountPrimary(viewing)}</div>
                  {discountSecondary(viewing) && (
                    <div className="text-xs text-ink-soft">{discountSecondary(viewing)}</div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-ink-soft">Usage</div>
                  <div className="font-medium text-ink">{usagePrimary(viewing)}</div>
                </div>
                <div>
                  <div className="text-xs text-ink-soft">Expiration</div>
                  <div className={expirationCell(viewing, now).muted ? "text-ink-soft" : "font-medium text-ink"}>
                    {expirationCell(viewing, now).text}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-ink-soft">Performance</div>
                  <div className="font-medium text-ink">{viewing.ordersCount} orders</div>
                  <div className="text-xs text-ink-soft">
                    {formatCurrencyDisplay(viewing.revenue, "IDR")} · {viewing.customers} customers
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs text-ink-soft">Scope</div>
                {viewing.scope === "ALL" ? (
                  <span className="text-sm text-ink">All Products</span>
                ) : viewing.products.length === 0 ? (
                  <span className="text-sm text-ink-soft">No products selected</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {viewing.products.map(p => <Badge key={p.id} variant="default">{p.name}</Badge>)}
                  </div>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {pendingDelete && (
        <ConfirmDialog
          open
          onOpenChange={open => { if (!open) setPendingDelete(null); }}
          title="Delete voucher?"
          description={`Permanently delete voucher "${pendingDelete.code}".`}
          confirmLabel="Delete"
          onConfirm={() => del.mutate(pendingDelete.id)}
        />
      )}
    </PageLayout>
  );
}
