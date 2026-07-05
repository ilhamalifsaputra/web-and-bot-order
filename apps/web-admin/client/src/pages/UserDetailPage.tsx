import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { CurrencyStack } from "../components/shared/CurrencyAmount";
import { CardRow } from "../components/shared/CardRow";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { apiPost } from "../api/client";

interface UserDetail {
  user: { id: number; username: string | null; fullName: string | null; telegramId: string; role: string; banned: boolean; banReason: string | null; walletBalance: string; walletBalanceUsdt: string };
  totalSpent: { idr: string; usdt: string };
  orders: { id: number; orderCode: string; status: string; totalIdr: string; createdAt: string }[];
  tickets: { id: number; subject: string; status: string; createdAt: string }[];
  ledger: { delta: string; balanceAfter: string; currency: string; reason: string; note: string | null; createdAt: string }[];
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
  const [walletCurrency, setWalletCurrency] = useState<"IDR" | "USDT">("IDR");
  const [walletError, setWalletError] = useState<string | null>(null);
  const [banReason, setBanReason] = useState("");

  const wallet = useMutation({
    mutationFn: () => apiPost(`/api/users/${userId}/wallet`, { ...walletForm, currency: walletCurrency }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["user", userId] });
      setWalletForm({ delta: "", note: "" });
      setWalletCurrency("IDR");
      setWalletError(null);
    },
    onError: (e: Error) => setWalletError(e.message),
  });

  const setRole = useMutation({
    mutationFn: (role: string) => apiPost(`/api/users/${userId}/role`, { role }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["user", userId] }); },
    onError: (e: Error) => alert(e.message),
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
          <CardContent className="divide-y divide-line">
            {user.banned && (
              <div className="mb-2 rounded bg-rust-tint px-3 py-2 text-xs font-medium text-rust-dark">
                BANNED{user.banReason ? ` — ${user.banReason}` : ""}
              </div>
            )}
            <CardRow label="Telegram ID" value={<span className="font-mono text-xs">{user.telegramId}</span>} />
            <CardRow label="Username" value={user.username ? `@${user.username}` : "—"} />
            <CardRow
              label="Role"
              value={
                user.role === "ADMIN" ? (
                  <StatusBadge status={user.role} />
                ) : (
                  <Select value={user.role} onValueChange={(role) => setRole.mutate(role)} disabled={setRole.isPending}>
                    <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {data.roles.map((r) => (
                        <SelectItem key={r} value={r}>{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )
              }
            />
            <CardRow label="Wallet" value={<CurrencyStack amounts={[{ currency: "IDR", value: user.walletBalance }, { currency: "USDT", value: user.walletBalanceUsdt }]} />} />
            <CardRow label="Total spent" value={<CurrencyStack amounts={[{ currency: "IDR", value: data.totalSpent.idr }, { currency: "USDT", value: data.totalSpent.usdt }]} />} />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          {/* Wallet adjust */}
          <Card>
            <CardHeader><CardTitle>Wallet Adjustment</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {walletError && <p className="text-xs text-rust">{walletError}</p>}
              <div className="flex gap-2">
                <Button type="button" size="sm" variant={walletCurrency === "IDR" ? "default" : "outline"} onClick={() => setWalletCurrency("IDR")}>IDR</Button>
                <Button type="button" size="sm" variant={walletCurrency === "USDT" ? "default" : "outline"} onClick={() => setWalletCurrency("USDT")}>USDT</Button>
              </div>
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
      <Card className="mb-6">
        <CardHeader><CardTitle>Recent Orders ({data.orders.length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={[
              { key: "code", header: "Code", render: o => <span className="font-mono text-xs">{o.orderCode}</span> },
              { key: "status", header: "Status", render: o => <StatusBadge status={o.status} /> },
              { key: "total", header: "Total", render: o => <span className="text-sm">{o.totalIdr}</span> },
              { key: "date", header: "Date", render: o => <span className="text-xs text-ink-soft">{new Date(o.createdAt).toLocaleDateString()}</span> },
            ]}
            data={data.orders}
            keyExtractor={o => o.id}
            onRowClick={o => navigate(`/orders/${o.id}`)}
            empty={<EmptyState title="No orders" />}
          />
        </CardContent>
      </Card>

      {/* Wallet ledger */}
      <Card>
        <CardHeader><CardTitle>Wallet Ledger ({data.ledger.length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={[
              { key: "delta", header: "Delta", render: l => <span className={`font-mono text-sm ${l.delta.startsWith("-") ? "text-rust" : "text-grass"}`}>{l.delta}</span> },
              { key: "currency", header: "Currency", render: l => <Badge variant="outline">{l.currency}</Badge> },
              { key: "balance", header: "Balance", render: l => <span className="font-mono text-sm">{l.balanceAfter}</span> },
              { key: "reason", header: "Reason", render: l => <span className="text-sm">{l.reason}</span> },
              { key: "note", header: "Note", render: l => <span className="text-xs text-ink-soft">{l.note ?? "—"}</span> },
              { key: "date", header: "Date", render: l => <span className="text-xs text-ink-soft">{new Date(l.createdAt).toLocaleDateString()}</span> },
            ]}
            data={data.ledger.map((l, i) => ({ ...l, _key: i }))}
            keyExtractor={l => l._key}
            empty={<EmptyState title="No ledger entries" />}
          />
        </CardContent>
      </Card>
    </PageLayout>
  );
}
