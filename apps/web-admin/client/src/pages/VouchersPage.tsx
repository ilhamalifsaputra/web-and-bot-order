import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
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
            <form
              onSubmit={e => { e.preventDefault(); create.mutate(form); }}
              className="flex flex-wrap gap-2"
            >
              {formError && <p className="w-full text-sm text-rust">{formError}</p>}
              <Input
                required
                placeholder="Code"
                value={form.code}
                onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
                className="w-32"
              />
              <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v }))}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(data?.types ?? ["PERCENT", "FIXED"]).map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                required
                placeholder="Value"
                value={form.value}
                onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                className="w-24"
              />
              <Input
                placeholder="Min purchase"
                value={form.min_purchase}
                onChange={e => setForm(f => ({ ...f, min_purchase: e.target.value }))}
                className="w-28"
              />
              <Input
                placeholder="Usage limit"
                value={form.usage_limit}
                onChange={e => setForm(f => ({ ...f, usage_limit: e.target.value }))}
                className="w-28"
              />
              <Input
                type="date"
                placeholder="Expires"
                value={form.expires_at}
                onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))}
                className="w-36"
              />
              <Button type="submit" disabled={create.isPending}>Create</Button>
            </form>
          </CardContent>
        </Card>
      )}

      <DataTable
        columns={[
          {
            key: "code",
            header: "Code",
            render: v => <span className="font-mono text-sm">{v.code}</span>,
          },
          {
            key: "type",
            header: "Type",
            render: v => <Badge variant="outline">{v.type}</Badge>,
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
            render: v => v.expiresAt ? v.expiresAt.slice(0, 10) : "—",
          },
          {
            key: "active",
            header: "Active",
            render: v => (
              <input
                type="checkbox"
                checked={v.isActive}
                onChange={e => toggle.mutate({ id: v.id, active: e.target.checked })}
                className="h-4 w-4"
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
        data={data?.vouchers ?? []}
        isLoading={!data}
        keyExtractor={v => v.id}
        empty={<EmptyState title="No vouchers found" description="Create your first voucher to offer discounts." />}
      />
    </PageLayout>
  );
}
