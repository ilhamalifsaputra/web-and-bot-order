import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { apiPost } from "../api/client";

interface BroadcastRow {
  id: number;
  message: string;
  segment: string;
  status: string;
  total: number;
  sent: number;
  scheduledAt: string | null;
  createdAt: string;
}

interface BroadcastData {
  segments: string[];
  counts: Record<string, number>;
  history: BroadcastRow[];
}

function useBroadcast() {
  return useQuery<BroadcastData>({
    queryKey: ["broadcast"],
    queryFn: async () => {
      const res = await fetch("/api/broadcast");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<BroadcastData>;
    },
  });
}

export function BroadcastPage() {
  const qc = useQueryClient();
  const { data, isError } = useBroadcast();
  const [form, setForm] = useState({ message: "", segment: "", scheduled_at: "" });
  const [formError, setFormError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () => apiPost("/api/broadcast", form),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast"] });
      setForm({ message: "", segment: "", scheduled_at: "" });
      setFormError(null);
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const cancel = useMutation({
    mutationFn: (id: number) => apiPost(`/api/broadcast/${id}/cancel`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["broadcast"] }); },
    onError: (e: Error) => alert(e.message),
  });

  if (isError) return <PageLayout title="Broadcast"><p style={{ color: "red" }}>Failed to load broadcast.</p></PageLayout>;

  return (
    <PageLayout title="Broadcast">
      <section style={{ background: "#f9f9f9", padding: 16, borderRadius: 6, marginBottom: 24 }}>
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>Compose Broadcast</h2>
        {formError && <p style={{ color: "red", margin: "0 0 8px" }}>{formError}</p>}
        <textarea
          placeholder="Message (max 4000 chars)"
          value={form.message}
          onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
          rows={5}
          style={{ width: "100%", padding: "6px 10px", marginBottom: 10, boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={form.segment}
            onChange={e => setForm(f => ({ ...f, segment: e.target.value }))}
            style={{ padding: "5px 8px" }}
          >
            <option value="">— pick segment —</option>
            {(data?.segments ?? []).map(s => (
              <option key={s} value={s}>{s} ({data?.counts[s] ?? 0})</option>
            ))}
          </select>
          <input
            type="datetime-local"
            value={form.scheduled_at}
            onChange={e => setForm(f => ({ ...f, scheduled_at: e.target.value }))}
            style={{ padding: "5px 8px" }}
          />
          <button
            onClick={() => send.mutate()}
            disabled={!form.message || !form.segment || send.isPending}
            style={{ padding: "6px 16px" }}
          >
            {form.scheduled_at ? "Schedule" : "Send now"}
          </button>
        </div>
      </section>

      <h2 style={{ fontSize: 15, marginBottom: 10 }}>History</h2>
      {!data ? (
        <p>Loading…</p>
      ) : data.history.length === 0 ? (
        <p>No broadcasts yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Message</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Segment</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Status</th>
              <th style={{ textAlign: "right", padding: "6px 8px" }}>Sent</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Scheduled</th>
              <th style={{ padding: "6px 8px" }} />
            </tr>
          </thead>
          <tbody>
            {data.history.map(b => (
              <tr key={b.id} style={{ borderTop: "1px solid #eee" }}>
                <td style={{ padding: "6px 8px", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {b.message.slice(0, 80)}{b.message.length > 80 ? "…" : ""}
                </td>
                <td style={{ padding: "6px 8px" }}>{b.segment}</td>
                <td style={{ padding: "6px 8px" }}>{b.status}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>{b.sent}/{b.total}</td>
                <td style={{ padding: "6px 8px", fontSize: 12 }}>
                  {b.scheduledAt ? new Date(b.scheduledAt).toLocaleString() : "immediate"}
                </td>
                <td style={{ padding: "6px 8px" }}>
                  {b.status === "PENDING" && (
                    <button
                      onClick={() => { if (confirm("Cancel this broadcast?")) cancel.mutate(b.id); }}
                      style={{ fontSize: 12, color: "red", background: "none", border: "1px solid #ccc", borderRadius: 3, cursor: "pointer", padding: "2px 8px" }}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageLayout>
  );
}
