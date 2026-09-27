import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { CurrencyBadge } from "../components/shared/CurrencyBadge";
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
import { CircleCheck, Ban } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface UserDetail {
  user: {
    id: number;
    username: string | null;
    fullName: string | null;
    telegramId: string | null;
    role: string;
    banned: boolean;
    banReason: string | null;
    walletBalance: string;
    walletBalanceUsdt: string;
    // Read-only display-currency preference (Task 2/6) — bot/storefront write
    // it via their own flows; admin only shows it (CurrencyBadge), never edits it.
    preferredCurrency: string | null;
  };
  totalSpent: { idr: string; usdt: string };
  orders: { id: number; orderCode: string; status: string; totalIdr: string; createdAt: string; createdAtDisplay: string | null }[];
  // No `subject` field — SupportTicket has no such column (Task 3 fixed the
  // matching backend bug in users.ts). `message` is the ticket's own text;
  // this block isn't rendered today (dead field since the original scaffold)
  // but the type is kept accurate to what the route actually returns.
  tickets: { id: number; message: string; status: string; createdAt: string; createdAtDisplay: string | null }[];
  ledger: { delta: string; balanceAfter: string; currency: string; reason: string; note: string | null; createdAt: string; createdAtDisplay: string | null }[];
  roles: string[];
  /** Real totals behind each capped list above — the card titles must show
   *  these, not `.length` of the (possibly truncated) array the server sent. */
  ordersTotal: number;
  ticketsTotal: number;
  ledgerTotal: number;
}

/** A card title's "(N)" — the real server total when the page has it, "N+"
 *  when the visible rows were capped short of that total (an older response
 *  shape with no total field, or the total genuinely missing). */
function countLabel(shown: number, total: number | undefined): string {
  if (total == null) return shown >= 20 ? `${shown}+` : String(shown);
  return String(total);
}

function useUserDetail(userId: string) {
  return useQuery<UserDetail>({
    queryKey: ["user", userId],
    queryFn: () => apiGet<UserDetail>(`/api/users/${userId}`),
  });
}

export function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isError } = useUserDetail(userId ?? "");
  const [walletForm, setWalletForm] = useState({ delta: "", note: "" });
  const [walletCurrency, setWalletCurrency] = useState<"IDR" | "USDT">("IDR");
  const [banReason, setBanReason] = useState("");

  const wallet = useMutation({
    mutationFn: () => apiPost(`/api/users/${userId}/wallet`, { ...walletForm, currency: walletCurrency }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["user", userId] });
      setWalletForm({ delta: "", note: "" });
      setWalletCurrency("IDR");
      toast.success("Wallet adjusted.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const setRole = useMutation({
    mutationFn: (role: string) => apiPost(`/api/users/${userId}/role`, { role }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["user", userId] });
      toast.success("Role updated.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const ban = useMutation({
    mutationFn: (doBan: boolean) => apiPost(`/api/users/${userId}/ban`, { banned: doBan ? "1" : "0", reason: banReason }),
    onSuccess: (_data, doBan) => {
      void qc.invalidateQueries({ queryKey: ["user", userId] });
      setBanReason("");
      toast.success(doBan ? "User banned." : "User unbanned.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  if (isError) return <PageLayout title="Customer"><p className="text-sm text-rust">Failed to load user.</p></PageLayout>;
  if (!data) return <PageLayout title="Customer"><p>Loading…</p></PageLayout>;

  const { user } = data;
  return (
    <PageLayout title={user.fullName ?? user.username ?? `User #${user.id}`}>
      <PageHeader
        title={user.fullName ?? user.username ?? `User #${user.id}`}
        breadcrumb={[{ label: "Customers", href: "/users" }]}
      />

      {/* User info */}
      <div className="grid grid-cols-1 gap-4 mb-6 sm:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
          <CardContent className="divide-y divide-line">
            {user.banned && (
              <div className="mb-2 rounded bg-rust-tint px-3 py-2 text-xs font-medium break-words text-rust-dark">
                BANNED{user.banReason ? ` — ${user.banReason}` : ""}
              </div>
            )}
            {/* Both are single unbroken tokens (a Telegram username runs to 32
                chars), so they need break-all — CardRow's generic break-words
                cannot break a token, leaving it to be clipped by the card. */}
            <CardRow label="Telegram ID" value={<span className="font-mono text-xs break-all">{user.telegramId ?? "—"}</span>} />
            <CardRow
              label="Username"
              value={<span className="break-all">{user.username ? `@${user.username}` : "—"}</span>}
            />
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
            <CardRow label="Display Currency" value={<CurrencyBadge currency={user.preferredCurrency as "USD" | "IDR" | null} />} />
            <CardRow label="Wallet" value={<CurrencyStack amounts={[{ currency: "IDR", value: user.walletBalance }, { currency: "USDT", value: user.walletBalanceUsdt }]} />} />
            <CardRow label="Total spent" value={<CurrencyStack amounts={[{ currency: "IDR", value: data.totalSpent.idr }, { currency: "USDT", value: data.totalSpent.usdt }]} />} />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          {/* Wallet adjust */}
          <Card>
            <CardHeader><CardTitle>Wallet Adjustment</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
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
                  trigger={<Button variant="outline"><CircleCheck className="h-4 w-4" />Unban user</Button>}
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
                    trigger={<Button variant="destructive"><Ban className="h-4 w-4" />Ban user</Button>}
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
        <CardHeader>
          <CardTitle>Recent Orders ({countLabel(data.orders.length, data.ordersTotal)})</CardTitle>
          {data.orders.length < data.ordersTotal && (
            <p className="text-xs text-ink-soft">Showing the {data.orders.length} most recent.</p>
          )}
        </CardHeader>
        <CardContent>
          <DataTable
            nested
            columns={[
              { key: "code", header: "Code", render: o => <span className="font-mono text-xs">{o.orderCode}</span> },
              { key: "status", header: "Status", render: o => <StatusBadge status={o.status} /> },
              { key: "total", header: "Total", render: o => <span className="text-sm">{o.totalIdr}</span> },
              { key: "date", header: "Date", render: o => <span className="text-xs text-ink-soft">{o.createdAtDisplay ?? "—"}</span> },
            ]}
            data={data.orders}
            keyExtractor={o => o.id}
            onRowClick={o => navigate(`/orders/${o.id}`)}
            empty={<EmptyState title="No orders" />}
          />
        </CardContent>
      </Card>

      {/* Wallet ledger */}
      <Card className="mt-6 scroll-mt-20" id="ledger">
        <CardHeader>
          <CardTitle>Wallet Ledger ({countLabel(data.ledger.length, data.ledgerTotal)})</CardTitle>
          {data.ledger.length < data.ledgerTotal && (
            <p className="text-xs text-ink-soft">Showing the {data.ledger.length} most recent.</p>
          )}
        </CardHeader>
        <CardContent>
          <DataTable
            nested
            columns={[
              { key: "delta", header: "Delta", render: l => <span className={`font-mono text-sm ${l.delta.startsWith("-") ? "text-rust" : "text-grass"}`}>{l.delta}</span> },
              { key: "currency", header: "Currency", render: l => <Badge variant="outline">{l.currency}</Badge> },
              { key: "balance", header: "Balance", render: l => <span className="font-mono text-sm">{l.balanceAfter}</span> },
              {
                key: "reason",
                header: "Reason",
                render: l => (
                  <span className="text-sm block max-w-[240px] truncate" title={l.reason}>
                    {l.reason}
                  </span>
                ),
              },
              {
                key: "note",
                header: "Note",
                render: l => (
                  <span
                    className="text-xs text-ink-soft block max-w-[240px] truncate"
                    title={l.note ?? undefined}
                  >
                    {l.note ?? "—"}
                  </span>
                ),
              },
              { key: "date", header: "Date", render: l => <span className="text-xs text-ink-soft">{l.createdAtDisplay ?? "—"}</span> },
            ]}
            data={data.ledger.map((l, i) => ({ ...l, _key: i }))}
            keyExtractor={l => l._key}
            empty={<EmptyState title="No ledger entries" />}
          />
        </CardContent>
      </Card>

      {/* Support Tickets */}
      <Card className="mt-6 scroll-mt-20" id="tickets">
        <CardHeader>
          <CardTitle>Support Tickets ({countLabel(data.tickets.length, data.ticketsTotal)})</CardTitle>
          {data.tickets.length < data.ticketsTotal && (
            <p className="text-xs text-ink-soft">Showing the {data.tickets.length} most recent.</p>
          )}
        </CardHeader>
        <CardContent>
          <DataTable
            nested
            columns={[
              {
                key: "subject",
                header: "Subject",
                render: t => (
                  <span
                    className="text-sm text-ink block max-w-[320px] truncate"
                    title={t.message}
                  >
                    {t.message}
                  </span>
                ),
              },
              { key: "status", header: "Status", render: t => <StatusBadge status={t.status} /> },
              { key: "date", header: "Date", render: t => <span className="text-xs text-ink-soft">{t.createdAtDisplay ?? "—"}</span> },
            ]}
            data={data.tickets}
            keyExtractor={t => t.id}
            onRowClick={t => navigate(`/support/${t.id}`)}
            empty={<EmptyState title="No support tickets" />}
          />
        </CardContent>
      </Card>
    </PageLayout>
  );
}
