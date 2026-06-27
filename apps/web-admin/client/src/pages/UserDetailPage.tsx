import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { apiPost } from "../api/client";

interface UserDetail {
  user: { id: number; username: string | null; fullName: string | null; telegramId: string; role: string; banned: boolean; banReason: string | null; walletBalance: string; walletCurrency: string };
  totalSpent: string;
  orders: { id: number; orderCode: string; status: string; totalIdr: string; createdAt: string }[];
  tickets: { id: number; subject: string; status: string; createdAt: string }[];
  ledger: { id: number; delta: string; balance: string; reason: string; note: string | null; createdAt: string }[];
  roles: string[];
}

function useUserDetail(userId: string) {
  return useQuery<UserDetail>({
    queryKey: ["user", userId],
    queryFn: async () => {
      const res = await fetch(`/api/users/${userId}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<UserDetail>;
    },
  });
}

export function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isError } = useUserDetail(userId ?? "");
  const [walletForm, setWalletForm] = useState({ delta: "", note: "" });
  const [walletError, setWalletError] = useState<string | null>(null);
  const [banReason, setBanReason] = useState("");

  const wallet = useMutation({
    mutationFn: () => apiPost(`/api/users/${userId}/wallet`, walletForm),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["user", userId] });
      setWalletForm({ delta: "", note: "" });
      setWalletError(null);
    },
    onError: (e: Error) => setWalletError(e.message),
  });

  const ban = useMutation({
    mutationFn: (doBan: boolean) => apiPost(`/api/users/${userId}/ban`, { banned: doBan ? "1" : "0", reason: banReason }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["user", userId] }); setBanReason(""); },
    onError: (e: Error) => alert(e.message),
  });

  if (isError) return <PageLayout title="Customer"><p style={{ color: "red" }}>Failed to load user.</p></PageLayout>;
  if (!data) return <PageLayout title="Customer"><p>Loading…</p></PageLayout>;

  const { user } = data;
  return (
    <PageLayout title={user.fullName ?? user.username ?? `User #${user.id}`}>
      <button onClick={() => navigate("/users")} style={{ marginBottom: 16, background: "none", border: "1px solid #ccc", borderRadius: 4, padding: "4px 12px", cursor: "pointer" }}>
        ← Back to Customers
      </button>

      <section style={{ marginBottom: 20 }}>
        <p><strong>Telegram ID:</strong> {user.telegramId}</p>
        <p><strong>Username:</strong> {user.username ? `@${user.username}` : "—"}</p>
        <p><strong>Role:</strong> {user.role}</p>
        <p><strong>Wallet:</strong> {user.walletBalance} {user.walletCurrency}</p>
        <p><strong>Total spent:</strong> {data.totalSpent}</p>
        {user.banned && <p style={{ color: "red" }}><strong>BANNED</strong>{user.banReason ? ` — ${user.banReason}` : ""}</p>}
      </section>

      {/* Wallet adjust */}
      <section style={{ background: "#f9f9f9", padding: 16, borderRadius: 6, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginBottom: 10 }}>Wallet Adjustment</h2>
        {walletError && <p style={{ color: "red", margin: "0 0 8px" }}>{walletError}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Amount (+ or −)" value={walletForm.delta} onChange={e => setWalletForm(f => ({ ...f, delta: e.target.value }))} style={{ width: 120, padding: "5px 8px" }} />
          <input placeholder="Reason (required)" value={walletForm.note} onChange={e => setWalletForm(f => ({ ...f, note: e.target.value }))} style={{ flex: 1, padding: "5px 8px" }} />
          <button onClick={() => wallet.mutate()} disabled={wallet.isPending} style={{ padding: "5px 14px" }}>Adjust</button>
        </div>
      </section>

      {/* Ban / unban */}
      <section style={{ marginBottom: 20 }}>
        {user.banned ? (
          <button onClick={() => ban.mutate(false)} style={{ padding: "6px 14px", background: "#28a745", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>
            Unban user
          </button>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="Ban reason (optional)" value={banReason} onChange={e => setBanReason(e.target.value)} style={{ flex: 1, padding: "5px 8px" }} />
            <button onClick={() => { if (confirm("Ban this user?")) ban.mutate(true); }} style={{ padding: "5px 14px", background: "#dc3545", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>
              Ban user
            </button>
          </div>
        )}
      </section>

      {/* Orders */}
      <section style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Recent Orders ({data.orders.length})</h2>
        {data.orders.length === 0 ? <p>No orders.</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ background: "#f5f5f5" }}>
              <th style={{ textAlign: "left", padding: "5px 8px" }}>Code</th>
              <th style={{ textAlign: "left", padding: "5px 8px" }}>Status</th>
              <th style={{ textAlign: "right", padding: "5px 8px" }}>Total</th>
              <th style={{ textAlign: "left", padding: "5px 8px" }}>Date</th>
            </tr></thead>
            <tbody>
              {data.orders.map(o => (
                <tr key={o.id} style={{ borderTop: "1px solid #eee", cursor: "pointer" }} onClick={() => navigate(`/orders/${o.id}`)}>
                  <td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{o.orderCode}</td>
                  <td style={{ padding: "5px 8px" }}>{o.status}</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>{o.totalIdr}</td>
                  <td style={{ padding: "5px 8px", fontSize: 12 }}>{new Date(o.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Wallet ledger */}
      <section>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Wallet Ledger ({data.ledger.length})</h2>
        {data.ledger.length === 0 ? <p>No ledger entries.</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ background: "#f5f5f5" }}>
              <th style={{ textAlign: "right", padding: "5px 8px" }}>Delta</th>
              <th style={{ textAlign: "right", padding: "5px 8px" }}>Balance</th>
              <th style={{ textAlign: "left", padding: "5px 8px" }}>Reason</th>
              <th style={{ textAlign: "left", padding: "5px 8px" }}>Note</th>
              <th style={{ textAlign: "left", padding: "5px 8px" }}>Date</th>
            </tr></thead>
            <tbody>
              {data.ledger.map(l => (
                <tr key={l.id} style={{ borderTop: "1px solid #eee" }}>
                  <td style={{ padding: "5px 8px", textAlign: "right", color: l.delta.startsWith("-") ? "red" : "green" }}>{l.delta}</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>{l.balance}</td>
                  <td style={{ padding: "5px 8px" }}>{l.reason}</td>
                  <td style={{ padding: "5px 8px", color: "#666" }}>{l.note ?? "—"}</td>
                  <td style={{ padding: "5px 8px", fontSize: 12 }}>{new Date(l.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </PageLayout>
  );
}
