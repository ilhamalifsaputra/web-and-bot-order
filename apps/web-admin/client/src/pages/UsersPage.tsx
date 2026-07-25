import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { CurrencyStack } from "../components/shared/CurrencyAmount";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Users, MoreVertical, Eye, Copy, Ban, CircleCheck } from "lucide-react";
import { SearchBar } from "../components/shared/SearchBar";
import { StatusBadge } from "../components/shared/StatusBadge";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface UserRow {
  id: number;
  username: string | null;
  fullName: string | null;
  telegramId: string | null;
  role: string;
  banned: boolean;
  createdAt: string;
  createdAtDisplay: string | null;
  lastSeenAt: string | null;
  lastSeenAtDisplay: string | null;
  totalSpent: { idr: string; usdt: string };
  orderCount: number;
}

/** First letter of the name shown for this row — full name, else username,
 * else "?" for the rare row with neither. */
function initialFor(row: UserRow): string {
  const source = row.fullName ?? row.username;
  return source && source.length > 0 ? source[0]!.toUpperCase() : "?";
}

/** True when this customer joined within the last 7 days — drives the
 * "New Customer" badge. Purely a threshold check on already-fetched data,
 * not a display-string computation (createdAtDisplay/lastSeenAtDisplay
 * remain server-formatted, per the plan's Global Constraints). */
function isNewCustomer(row: UserRow): boolean {
  return Date.now() - new Date(row.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000;
}

function useUsers(q: string) {
  return useQuery<{ users: UserRow[]; q: string }>({
    queryKey: ["users", q],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      const res = await fetch(`/api/users?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<{ users: UserRow[]; q: string }>;
    },
  });
}

export function UsersPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [banTargetId, setBanTargetId] = useState<number | null>(null);
  const { data, isLoading, isError } = useUsers(q);

  const banMutation = useMutation({
    mutationFn: (vars: { id: number; doBan: boolean }) =>
      apiPost(`/api/users/${vars.id}/ban`, { banned: vars.doBan ? "1" : "0" }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success(vars.doBan ? "Customer suspended." : "Customer unbanned.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const banTarget = data?.users.find((u) => u.id === banTargetId) ?? null;

  if (isError) {
    return (
      <PageLayout title="Customers">
        <p className="text-rust">Failed to load customers.</p>
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Customers">
      <PageHeader title="Customers" />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQ(input.trim());
        }}
        className="mb-4"
      >
        <FilterBar>
          <SearchBar
            value={input}
            onChange={setInput}
            placeholder="Search by name, username, Telegram ID…"
          />
          <Button type="submit">Search</Button>
          {q && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setInput("");
                setQ("");
              }}
            >
              Clear
            </Button>
          )}
        </FilterBar>
      </form>

      <DataTable
        columns={[
          {
            key: "customer",
            header: "Customer",
            render: (row) => (
              <div className="flex items-center gap-3">
                <Avatar size="default">
                  <AvatarFallback>{initialFor(row)}</AvatarFallback>
                </Avatar>
                <div>
                  <div className="text-sm font-medium text-ink">
                    {row.fullName ?? "—"}
                  </div>
                  {row.username && (
                    <div className="text-xs text-ink-soft">{`@${row.username}`}</div>
                  )}
                  <div className="font-mono text-xs text-ink-faint">
                    {row.telegramId ?? "—"}
                  </div>
                </div>
              </div>
            ),
          },
          {
            key: "status",
            header: "Status",
            render: (row) => (
              <div className="flex flex-col items-start gap-1">
                <StatusBadge status={row.role} />
                {row.banned ? (
                  <StatusBadge status="BANNED" />
                ) : isNewCustomer(row) ? (
                  <StatusBadge status="NEW_CUSTOMER" />
                ) : null}
              </div>
            ),
          },
          {
            key: "activity",
            header: "Activity",
            render: (row) => (
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline gap-1">
                  <span className="text-xs text-ink-soft">Joined</span>
                  <span className="text-xs text-ink">{row.createdAtDisplay ?? "—"}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-xs text-ink-soft">Last Seen</span>
                  <span className="text-xs text-ink">{row.lastSeenAtDisplay ?? "—"}</span>
                </div>
              </div>
            ),
          },
          {
            key: "totalSpent",
            header: "Spending",
            render: (row) => (
              <CurrencyStack
                amounts={[
                  { currency: "IDR", value: row.totalSpent.idr },
                  { currency: "USDT", value: row.totalSpent.usdt },
                ]}
              />
            ),
          },
          {
            key: "orderCount",
            header: "Orders",
            render: (row) => (
              <span className="font-display text-sm font-semibold text-ink">{row.orderCount}</span>
            ),
          },
          {
            key: "actions",
            header: "",
            render: (row) => (
              <div onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${row.fullName ?? row.username ?? "customer"}`}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => navigate(`/users/${row.id}`)}>
                      <Eye className="h-4 w-4" />
                      View Customer
                    </DropdownMenuItem>
                    {row.telegramId && (
                      <DropdownMenuItem
                        onSelect={() => {
                          void navigator.clipboard
                            ?.writeText(row.telegramId!)
                            .then(() => toast.success("Telegram ID copied."))
                            .catch(() => toast.error("Couldn't copy to the clipboard."));
                        }}
                      >
                        <Copy className="h-4 w-4" />
                        Copy Telegram ID
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    {row.banned ? (
                      <DropdownMenuItem
                        onSelect={(e) => {
                          e.preventDefault();
                          setBanTargetId(row.id);
                        }}
                      >
                        <CircleCheck className="h-4 w-4" />
                        Unban
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={(e) => {
                          e.preventDefault();
                          setBanTargetId(row.id);
                        }}
                      >
                        <Ban className="h-4 w-4" />
                        Suspend
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ),
          },
        ]}
        data={data?.users ?? []}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => navigate(`/users/${row.id}`)}
        empty={
          <EmptyState
            icon={Users}
            title="No customers yet"
            description="Customers will appear here once they interact with the shop."
          />
        }
      />

      {banTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setBanTargetId(null);
          }}
          title={banTarget.banned ? "Unban this customer?" : "Suspend this customer?"}
          description={
            banTarget.banned
              ? "The customer will be able to use the bot again."
              : "The customer will be blocked from using the bot."
          }
          confirmLabel={banTarget.banned ? "Unban" : "Suspend"}
          variant={banTarget.banned ? "default" : "destructive"}
          onConfirm={() => banMutation.mutate({ id: banTarget.id, doBan: !banTarget.banned })}
        />
      )}
    </PageLayout>
  );
}
