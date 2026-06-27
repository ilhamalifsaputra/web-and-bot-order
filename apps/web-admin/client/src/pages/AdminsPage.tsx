import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { apiPost } from "../api/client";

interface AdminRow {
  telegramId: number;
  role: string;
  passwordSet: boolean;
  twoFa: boolean;
  hasSession: boolean;
  name: string | null;
  isSelf: boolean;
  fromEnv: boolean;
}

function useAdmins() {
  return useQuery<{ admins: AdminRow[]; roles: string[] }>({
    queryKey: ["admins"],
    queryFn: async () => {
      const res = await fetch("/api/admins");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<{ admins: AdminRow[]; roles: string[] }>;
    },
  });
}

export function AdminsPage() {
  const qc = useQueryClient();
  const { data, isError } = useAdmins();
  const [addId, setAddId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => apiPost("/api/admins/add", { telegram_id: addId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["admins"] }); setAddId(""); setAddError(null); },
    onError: (e: Error) => setAddError(e.message),
  });

  const remove = useMutation({
    mutationFn: (tgId: number) => apiPost("/api/admins/remove", { telegram_id: String(tgId) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["admins"] }); },
    onError: (e: Error) => alert(e.message),
  });

  const setRole = useMutation({
    mutationFn: ({ tgId, role }: { tgId: number; role: string }) =>
      apiPost(`/api/admins/${tgId}/role`, { role }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["admins"] }); },
    onError: (e: Error) => alert(e.message),
  });

  const forceLogout = useMutation({
    mutationFn: (tgId: number) => apiPost(`/api/admins/${tgId}/logout`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["admins"] }); },
    onError: (e: Error) => alert(e.message),
  });

  if (isError) return <PageLayout title="Admins"><p style={{ color: "red" }}>Failed to load admins.</p></PageLayout>;

  return (
    <PageLayout title="Admins">
      <div style={{ marginBottom: 20, display: "flex", gap: 8, alignItems: "center" }}>
        <input
          placeholder="Telegram ID"
          value={addId}
          onChange={e => setAddId(e.target.value)}
          style={{ padding: "5px 8px", width: 160 }}
        />
        <button onClick={() => add.mutate()} disabled={!addId || add.isPending} style={{ padding: "5px 14px" }}>
          + Add Admin
        </button>
        {addError && <span style={{ color: "red" }}>{addError}</span>}
      </div>

      {!data ? (
        <p>Loading…</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Telegram ID</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Name</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Role</th>
              <th style={{ textAlign: "center", padding: "6px 8px" }}>Pwd</th>
              <th style={{ textAlign: "center", padding: "6px 8px" }}>2FA</th>
              <th style={{ textAlign: "center", padding: "6px 8px" }}>Session</th>
              <th style={{ padding: "6px 8px" }} />
            </tr>
          </thead>
          <tbody>
            {data.admins.map(a => (
              <tr key={a.telegramId} style={{ borderTop: "1px solid #eee" }}>
                <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>
                  {a.telegramId}{a.isSelf ? " (you)" : ""}
                </td>
                <td style={{ padding: "6px 8px" }}>{a.name ?? "—"}</td>
                <td style={{ padding: "6px 8px" }}>
                  <select
                    value={a.role}
                    onChange={e => setRole.mutate({ tgId: a.telegramId, role: e.target.value })}
                    disabled={a.isSelf}
                  >
                    {data.roles.map(r => <option key={r}>{r}</option>)}
                  </select>
                </td>
                <td style={{ padding: "6px 8px", textAlign: "center" }}>{a.passwordSet ? "✓" : "—"}</td>
                <td style={{ padding: "6px 8px", textAlign: "center" }}>{a.twoFa ? "✓" : "—"}</td>
                <td style={{ padding: "6px 8px", textAlign: "center" }}>
                  {a.hasSession ? (
                    <button
                      onClick={() => forceLogout.mutate(a.telegramId)}
                      disabled={a.isSelf}
                      style={{ fontSize: 12, color: "orange", background: "none", border: "none", cursor: "pointer" }}
                    >
                      Logout
                    </button>
                  ) : "—"}
                </td>
                <td style={{ padding: "6px 8px" }}>
                  {!a.fromEnv && !a.isSelf && (
                    <button
                      onClick={() => { if (confirm(`Remove admin ${a.telegramId}?`)) remove.mutate(a.telegramId); }}
                      style={{ color: "red", background: "none", border: "none", cursor: "pointer" }}
                    >
                      Remove
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
