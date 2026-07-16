import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, Tag } from "lucide-react";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { FilterBar } from "../components/shared/FilterBar";
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
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { StatusBadge } from "../components/shared/StatusBadge";
import { apiPost } from "../api/client";

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

type VoucherStatus = "active" | "expired" | "usedUp";

/** Precedence: an expired code is "expired" even if never used; a fully-used
 *  code is "usedUp" even if not yet expired; otherwise it's "active" only
 *  when the admin hasn't manually disabled it — a manually-disabled voucher
 *  that's neither expired nor used up matches none of the three status
 *  filters (it's still visible via the existing Active column). */
function getVoucherStatus(v: Voucher, now: Date): VoucherStatus | null {
  if (v.expiresAt && new Date(v.expiresAt).getTime() < now.getTime()) return "expired";
  if (v.usageLimit != null && v.usedCount >= v.usageLimit) return "usedUp";
  return v.isActive ? "active" : null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** True when the voucher is still genuinely usable (active status) and its
 *  expiry falls within the next 7 days. */
function isExpiringSoon(v: Voucher, now: Date): boolean {
  if (!v.expiresAt) return false;
  if (getVoucherStatus(v, now) !== "active") return false;
  const daysLeft = (new Date(v.expiresAt).getTime() - now.getTime()) / MS_PER_DAY;
  return daysLeft >= 0 && daysLeft <= 7;
}

function useVouchers() {
  return useQuery<{ vouchers: Voucher[]; types: string[] }>({
    queryKey: ["vouchers"],
    queryFn: async () => {
      const res = await fetch("/api/vouchers");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<{ vouchers: Voucher[]; types: string[] }>;
    },
  });
}

export function VouchersPage() {
  const qc = useQueryClient();
  const { data, isError } = useVouchers();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ code: "", type: "PERCENT", value: "", min_purchase: "", usage_limit: "", expires_at: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<VoucherStatus | "_all_">("_all_");
  const [copiedId, setCopiedId] = useState<number | null>(null);

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
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["vouchers"] }); },
    onError: (e: Error) => alert(e.message),
  });

  if (isError) return <PageLayout title="Vouchers"><p className="text-sm text-rust">Failed to load vouchers.</p></PageLayout>;

  const now = new Date();
  const vouchers = data?.vouchers ?? [];
  const filteredVouchers = statusFilter === "_all_"
    ? vouchers
    : vouchers.filter(v => getVoucherStatus(v, now) === statusFilter);

  return (
    <PageLayout title="Vouchers">
      <PageHeader
        title="Vouchers"
        actions={
          <Button onClick={() => setShowForm(v => !v)}>
            {showForm ? "Cancel" : "+ New Voucher"}
          </Button>
        }
      />

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
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Status</label>
          <Select
            value={statusFilter}
            onValueChange={v => setStatusFilter(v as VoucherStatus | "_all_")}
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

      <DataTable
        columns={[
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
                trigger={<Button variant="ghost" size="sm" className="text-rust">Delete</Button>}
                title="Delete voucher?"
                description={`Permanently delete voucher "${v.code}".`}
                confirmLabel="Delete"
                onConfirm={() => del.mutate(v.id)}
              />
            ),
          },
        ]}
        data={filteredVouchers}
        isLoading={!data}
        keyExtractor={v => v.id}
        empty={
          statusFilter === "_all_"
            ? <EmptyState icon={Tag} title="No vouchers found" description="Create your first voucher to offer discounts." />
            : <EmptyState icon={Tag} title="No matching vouchers" description="Try a different status filter." />
        }
      />
    </PageLayout>
  );
}
