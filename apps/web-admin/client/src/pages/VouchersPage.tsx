import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
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

  if (isError) return <PageLayout title="Vouchers"><p style={{ color: "red" }}>Failed to load vouchers.</p></PageLayout>;

  return (
    <PageLayout title="Vouchers">
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => setShowForm(v => !v)} style={{ padding: "6px 14px" }}>
          {showForm ? "Cancel" : "+ New Voucher"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={e => { e.preventDefault(); create.mutate(form); }}
          style={{ background: "#f9f9f9", padding: 16, borderRadius: 6, marginBottom: 20, display: "flex", flexWrap: "wrap", gap: 10 }}
        >
          {formError && <p style={{ width: "100%", color: "red", margin: 0 }}>{formError}</p>}
          <input required placeholder="Code" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} style={{ padding: "5px 8px", width: 120 }} />
          <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} style={{ padding: "5px 8px" }}>
            {(data?.types ?? ["PERCENT", "FIXED"]).map(t => <option key={t}>{t}</option>)}
          </select>
          <input required placeholder="Value" value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} style={{ padding: "5px 8px", width: 90 }} />
          <input placeholder="Min purchase" value={form.min_purchase} onChange={e => setForm(f => ({ ...f, min_purchase: e.target.value }))} style={{ padding: "5px 8px", width: 110 }} />
          <input placeholder="Usage limit" value={form.usage_limit} onChange={e => setForm(f => ({ ...f, usage_limit: e.target.value }))} style={{ padding: "5px 8px", width: 100 }} />
          <input type="date" placeholder="Expires" value={form.expires_at} onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))} style={{ padding: "5px 8px" }} />
          <button type="submit" disabled={create.isPending} style={{ padding: "5px 14px" }}>Create</button>
        </form>
      )}

      {!data ? (
        <p>Loading…</p>
      ) : data.vouchers.length === 0 ? (
        <p>No vouchers found.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Code</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Type</th>
              <th style={{ textAlign: "right", padding: "6px 8px" }}>Value</th>
              <th style={{ textAlign: "right", padding: "6px 8px" }}>Used</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Expires</th>
              <th style={{ textAlign: "center", padding: "6px 8px" }}>Active</th>
              <th style={{ padding: "6px 8px" }} />
            </tr>
          </thead>
          <tbody>
            {data.vouchers.map(v => (
              <tr key={v.id} style={{ borderTop: "1px solid #eee" }}>
                <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{v.code}</td>
                <td style={{ padding: "6px 8px" }}>{v.type}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>{v.value}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>{v.usedCount}{v.usageLimit ? `/${v.usageLimit}` : ""}</td>
                <td style={{ padding: "6px 8px" }}>{v.expiresAt ? v.expiresAt.slice(0, 10) : "—"}</td>
                <td style={{ padding: "6px 8px", textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={v.isActive}
                    onChange={e => toggle.mutate({ id: v.id, active: e.target.checked })}
                  />
                </td>
                <td style={{ padding: "6px 8px" }}>
                  <button
                    onClick={() => { if (confirm(`Delete voucher ${v.code}?`)) del.mutate(v.id); }}
                    style={{ color: "red", background: "none", border: "none", cursor: "pointer" }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageLayout>
  );
}
