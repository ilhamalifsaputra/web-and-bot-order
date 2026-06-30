import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
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

  if (isError) return <PageLayout title="Customer"><p className="text-sm text-rust">Failed to load user.</p></PageLayout>;
  if (!data) return <PageLayout title="Customer"><p>Loading…</p></PageLayout>;

  const { user } = data;
  return (
    <PageLayout title={user.fullName ?? user.username ?? `User #${user.id}`}>
      <PageHeader
        title={user.fullName ?? user.username ?? `User #${user.id}`}
        breadcrumb={[{ label: "Customers", href: "/users" }]}
        actions={<Button variant="outline" size="sm" onClick={() => navigate("/users")}>← Back</Button>}
      />

      {/* User info */}
      <div className="grid grid-cols-1 gap-4 mb-6 sm:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            {user.banned && (
              <div className="mb-2 rounded bg-rust/10 px-3 py-2 text-xs font-medium text-rust">
                BANNED{user.banReason ? ` — ${user.banReason}` : ""}
              </div>
            )}
            <div className="flex justify-between"><span className="text-ink-soft">Telegram ID</span><span className="font-mono text-xs">{user.telegramId}</span></div>
            <div className="flex justify-between"><span className="text-ink-soft">Username</span><span>{user.username ? `@${user.username}` : "—"}</span></div>
            <div className="flex justify-between"><span className="text-ink-soft">Role</span><span><Badge variant="outline">{user.role}</Badge></span></div>
            <div className="flex justify-between"><span className="text-ink-soft">Wallet</span><span className="font-mono">{user.walletBalance} {user.walletCurrency}</span></div>
            <div className="flex justify-between"><span className="text-ink-soft">Total spent</span><span>{data.totalSpent}</span></div>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          {/* Wallet adjust */}
          <Card>
            <CardHeader><CardTitle>Wallet Adjustment</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {walletError && <p className="text-xs text-rust">{walletError}</p>}
              <div className="flex gap-2">
                <Input placeholder="Amount (+ or −)" value={walletForm.delta} onChange={e => setWalletForm(f => ({ ...f, delta: e.target.value }))} className="w-32" />
                <Input placeholder="Reason (required)" value={walletForm.note} onChange={e => setWalletForm(f => ({ ...f, note: e.target.value }))} className="flex-1" />
                <Button onClick={() => wallet.mutate()} disabled={wallet.isPending}>Adjust</Button>
              </div>
            </CardContent>
          </Card>

          {/* Ban / unban */}
          <Card>
            <CardHeader><CardTitle>Account</CardTitle></CardHeader>
            <CardContent>
              {user.banned ? (
                <ConfirmDialog
                  trigger={<Button variant="outline">Unban user</Button>}
                  title="Unban this user?"
                  description="The user will be able to use the bot again."
                  confirmLabel="Unban"
                  variant="default"
                  onConfirm={() => ban.mutate(false)}
                />
              ) : (
                <div className="flex gap-2">
                  <Input placeholder="Ban reason (optional)" value={banReason} onChange={e => setBanReason(e.target.value)} className="flex-1" />
                  <ConfirmDialog
                    trigger={<Button variant="destructive">Ban user</Button>}
                    title="Ban this user?"
                    description="The user will be blocked from using the bot."
                    confirmLabel="Ban"
                    onConfirm={() => ban.mutate(true)}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Orders */}
      <h2 className="text-sm font-semibold text-ink mb-3">Recent Orders ({data.orders.length})</h2>
      <DataTable
        columns={[
          { key: "code", header: "Code", render: o => <span className="font-mono text-xs">{o.orderCode}</span> },
          { key: "status", header: "Status", render: o => <StatusBadge status={o.status} /> },
          { key: "total", header: "Total", render: o => <span className="text-sm">{o.totalIdr}</span> },
          { key: "date", header: "Date", render: o => <span className="text-xs text-ink-faint">{new Date(o.createdAt).toLocaleDateString()}</span> },
        ]}
        data={data.orders}
        keyExtractor={o => o.id}
        onRowClick={o => navigate(`/orders/${o.id}`)}
        empty={<EmptyState title="No orders" />}
      />

      {/* Wallet ledger */}
      <h2 className="text-sm font-semibold text-ink mb-3 mt-6">Wallet Ledger ({data.ledger.length})</h2>
      <DataTable
        columns={[
          { key: "delta", header: "Delta", render: l => <span className={`font-mono text-sm ${l.delta.startsWith("-") ? "text-rust" : "text-grass"}`}>{l.delta}</span> },
          { key: "balance", header: "Balance", render: l => <span className="font-mono text-sm">{l.balance}</span> },
          { key: "reason", header: "Reason", render: l => <span className="text-sm">{l.reason}</span> },
          { key: "note", header: "Note", render: l => <span className="text-xs text-ink-soft">{l.note ?? "—"}</span> },
          { key: "date", header: "Date", render: l => <span className="text-xs text-ink-faint">{new Date(l.createdAt).toLocaleDateString()}</span> },
        ]}
        data={data.ledger}
        keyExtractor={l => l.id}
        empty={<EmptyState title="No ledger entries" />}
      />
    </PageLayout>
  );
}
