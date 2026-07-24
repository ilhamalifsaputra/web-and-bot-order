import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, Tag, Plus, X, Trash2, Ticket, CheckCircle2, Clock, Ban } from "lucide-react";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { StatCard } from "../components/shared/StatCard";
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
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { StatusBadge } from "../components/shared/StatusBadge";
import { toast } from "sonner";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

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
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Per-row "Expiring Soon" badge — a display annotation on already-fetched
 *  rows, not a filter/aggregate, so no pagination-correctness concern here
 *  (unlike the status Select, which now goes server-side — see useVouchers). */
function isExpiringSoon(v: Voucher, now: Date): boolean {
  if (!v.expiresAt) return false;
  if (!v.isActive) return false;
  if (new Date(v.expiresAt).getTime() < now.getTime()) return false; // already expired
  if (v.usageLimit != null && v.usedCount >= v.usageLimit) return false; // already used up
  const daysLeft = (new Date(v.expiresAt).getTime() - now.getTime()) / MS_PER_DAY;
  return daysLeft >= 0 && daysLeft <= 7;
}

function useVouchers(q: string, status: string, page: number) {
  return useQuery<{
    vouchers: Voucher[];
    types: string[];
    total: number;
    page: number;
    pageSize: number;
    stats: { total: number; active: number; expiringSoon: number; usedUp: number };
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

export function VouchersPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ code: "", type: "PERCENT", value: "", min_purchase: "", usage_limit: "", expires_at: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [qDraft, setQDraft] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
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

  const create = useMutation({
    mutationFn: (body: Record<string, string>) => apiPost("/api/vouchers", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["vouchers"] });
      setShowForm(false);
      setForm({ code: "", type: "PERCENT", value: "", min_purchase: "", usage_limit: "", expires_at: "" });
      setFormError(null);
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiPost(`/api/vouchers/${id}/toggle`, { is_active: active ? "1" : "0" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["vouchers"] }); },
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
          <Button onClick={() => setShowForm(v => !v)}>
            {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {showForm ? "Cancel" : "New Voucher"}
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Vouchers" value={data?.stats.total ?? 0} icon={Ticket} isLoading={!data} />
        <StatCard label="Active" value={data?.stats.active ?? 0} icon={CheckCircle2} tone="success" isLoading={!data} />
        <StatCard label="Expiring Soon" value={data?.stats.expiringSoon ?? 0} icon={Clock} tone="warning" isLoading={!data} />
        <StatCard label="Used Up" value={data?.stats.usedUp ?? 0} icon={Ban} isLoading={!data} />
      </div>

      {showForm && (
        <Card className="mb-6">
          <CardHeader><CardTitle>New Voucher</CardTitle></CardHeader>
          <CardContent>
            {/* F-014: every field now has a persistent visible label (not
             *  placeholder-only text), matching the Label-above-field
             *  pattern used in ProductCreatePage.tsx / DenominationCreatePage.tsx —
             *  including the Type combobox, which previously had no label at
             *  all (confirmed via accessibility snapshot in the audit). */}
            <form
              onSubmit={e => { e.preventDefault(); create.mutate(form); }}
              className="flex flex-wrap items-start gap-3"
            >
              {formError && <p className="w-full text-sm text-rust">{formError}</p>}
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
              <Button type="submit" disabled={create.isPending} className="self-end">
                Create
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
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="usedUp">Used up</SelectItem>
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
            key: "code",
            header: "Code",
            render: v => (
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
            ),
          },
          {
            key: "type",
            header: "Type",
            render: v => <StatusBadge status={v.type} />,
          },
          {
            key: "value",
            header: "Value",
            render: v => v.value,
          },
          {
            key: "used",
            header: "Used",
            render: v => `${v.usedCount}${v.usageLimit ? `/${v.usageLimit}` : ""}`,
          },
          {
            key: "expires",
            header: "Expires",
            render: v => (
              <div className="flex flex-col items-start gap-1">
                <span>{v.expiresAtDisplay ?? "—"}</span>
                {isExpiringSoon(v, now) && <StatusBadge status="EXPIRING_SOON" />}
              </div>
            ),
          },
          {
            key: "active",
            header: "Active",
            render: v => (
              <Switch
                checked={v.isActive}
                onCheckedChange={(checked) => toggle.mutate({ id: v.id, active: checked })}
              />
            ),
          },
          {
            key: "actions",
            header: "",
            render: v => (
              <ConfirmDialog
                trigger={<Button variant="ghost" size="sm" className="text-rust"><Trash2 className="h-4 w-4" />Delete</Button>}
                title="Delete voucher?"
                description={`Permanently delete voucher "${v.code}".`}
                confirmLabel="Delete"
                onConfirm={() => del.mutate(v.id)}
              />
            ),
          },
        ]}
        data={data?.vouchers ?? []}
        isLoading={!data}
        keyExtractor={v => v.id}
        empty={
          status || q
            ? <EmptyState icon={Tag} title="No matching vouchers" description="Try a different search or status filter." />
            : <EmptyState icon={Tag} title="No vouchers found" description="Create your first voucher to offer discounts." />
        }
      />
    </PageLayout>
  );
}
