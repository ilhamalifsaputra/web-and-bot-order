import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { Pagination } from "../components/shared/Pagination";
import { CurrencyStack, type CurrencyAmount } from "../components/shared/CurrencyAmount";
import { CustomersKpiRow } from "./customers/CustomersKpiRow";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "../components/shared/DateInput";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Users, MoreVertical, Eye, ShoppingBag, Wallet, LifeBuoy, Copy, Ban, CircleCheck } from "lucide-react";
import { formatRelativeTime } from "../lib/relativeTime";
import { apiGet, apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";
import { useDebouncedValue } from "../hooks/useDebouncedValue";

interface CustomerRow {
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
  totalOrders: number;
  deliveredOrders: number;
  lastOrderAt: string | null;
  lastOrderAtDisplay: string | null;
}

interface CustomersData {
  users: CustomerRow[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  roles: string[];
}

interface Filters {
  q: string;
  role: string; // "" | "CUSTOMER" | "RESELLER"
  status: string; // "" | "active" | "banned"
  since: string;
  until: string;
  lastSeenSince: string;
  lastSeenUntil: string;
  sort: string; // "newest" | "oldest" | "lastSeen" | "spend"
  page: number;
  pageSize: number;
}

/** First letter of the name shown for this row — full name, else username,
 * else "?" for the rare row with neither. */
function initialFor(row: CustomerRow): string {
  const source = row.fullName ?? row.username;
  return source && source.length > 0 ? source[0]!.toUpperCase() : "?";
}

/** True when this customer joined within the last 7 days — drives the
 * "New Customer" badge. Purely a threshold check on already-fetched data,
 * not a display-string computation (createdAtDisplay/lastSeenAtDisplay
 * remain server-formatted, per the plan's Global Constraints). */
function isNewCustomer(row: CustomerRow): boolean {
  return Date.now() - new Date(row.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000;
}

/** Primary identity line — real name, else the Telegram handle standing in
 * for it, else a plain-English fallback (never a bare "—"). */
function primaryIdentity(row: CustomerRow): string {
  if (row.fullName) return row.fullName;
  if (row.username) return `@${row.username}`;
  return "Unknown Customer";
}

/** Secondary line — only shown when it adds information beyond the primary
 * line (i.e. the username wasn't already promoted into it above). */
function secondaryIdentity(row: CustomerRow): string {
  return row.fullName && row.username ? `@${row.username}` : "";
}

/** The identifier used to jump to this customer's filtered order list —
 * whichever of telegram id / username / full name is available first. */
function targetForOrders(row: CustomerRow): string | null {
  return row.telegramId ?? row.username ?? row.fullName ?? null;
}

function roleLabel(role: string): string {
  return role.charAt(0) + role.slice(1).toLowerCase();
}

const SORT_LABELS: Record<string, string> = {
  newest: "Newest",
  oldest: "Oldest",
  lastSeen: "Last Seen",
  spend: "Highest Spender (IDR)",
};

const EMPTY_FILTERS: Filters = {
  q: "",
  role: "",
  status: "",
  since: "",
  until: "",
  lastSeenSince: "",
  lastSeenUntil: "",
  sort: "newest",
  page: 1,
  pageSize: 20,
};

function useCustomers(filters: Filters) {
  return useQuery<CustomersData>({
    queryKey: ["users", filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.q) params.set("q", filters.q);
      if (filters.role) params.set("role", filters.role);
      if (filters.status) params.set("status", filters.status);
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      if (filters.lastSeenSince) params.set("lastSeenSince", filters.lastSeenSince);
      if (filters.lastSeenUntil) params.set("lastSeenUntil", filters.lastSeenUntil);
      if (filters.sort !== "newest") params.set("sort", filters.sort);
      if (filters.page > 1) params.set("page", String(filters.page));
      if (filters.pageSize !== 20) params.set("pageSize", String(filters.pageSize));
      return apiGet<CustomersData>(`/api/users?${params.toString()}`);
    },
  });
}

/** Non-zero currency lines only — a customer who has only ever paid in USDT
 * shouldn't show a "Rp0" line, and vice versa. */
function nonZeroAmounts(spent: { idr: string; usdt: string }): CurrencyAmount[] {
  const amounts: CurrencyAmount[] = [];
  if (Number(spent.idr) !== 0) amounts.push({ currency: "IDR", value: spent.idr });
  if (Number(spent.usdt) !== 0) amounts.push({ currency: "USDT", value: spent.usdt });
  return amounts;
}

export function UsersPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [banTargetId, setBanTargetId] = useState<number | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQ = searchParams.get("q") ?? "";
  const [draft, setDraft] = useState({
    role: "",
    status: "",
    since: "",
    until: "",
    lastSeenSince: "",
    lastSeenUntil: "",
    sort: "newest",
  });
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS, q: initialQ });
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Search is live/debounced rather than Apply-gated (unlike the other
  // filters below) — its own immediate-typing state, separate from `draft`.
  const [searchInput, setSearchInput] = useState(initialQ);
  const debouncedQ = useDebouncedValue(searchInput, 300);

  useEffect(() => {
    setFilters((f) => (f.q === debouncedQ ? f : { ...f, q: debouncedQ, page: 1 }));
  }, [debouncedQ]);

  useEffect(() => {
    setSearchParams(debouncedQ ? { q: debouncedQ } : {}, { replace: true });
  }, [debouncedQ, setSearchParams]);

  const { data, isLoading, isFetching, isError, refetch } = useCustomers(filters);

  // A stale selection surviving a new page/filter result set would let the
  // Export bulk action silently apply to rows no longer on screen — clear it
  // whenever the query changes (identical discipline to OrdersPage.tsx).
  useEffect(() => {
    setSelected(new Set());
  }, [filters]);

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

  const roles = data?.roles ?? [];
  const pageUsers = data?.users ?? [];

  function applyFilters() {
    setFilters((f) => ({
      ...f,
      role: draft.role,
      status: draft.status,
      since: draft.since,
      until: draft.until,
      lastSeenSince: draft.lastSeenSince,
      lastSeenUntil: draft.lastSeenUntil,
      sort: draft.sort,
      page: 1,
    }));
  }

  function clearFilters() {
    setDraft({ role: "", status: "", since: "", until: "", lastSeenSince: "", lastSeenUntil: "", sort: "newest" });
    setSearchInput("");
    setFilters(EMPTY_FILTERS);
    setSearchParams({}, { replace: true });
  }

  const hasActiveFilter = Boolean(
    filters.q ||
      filters.role ||
      filters.status ||
      filters.since ||
      filters.until ||
      filters.lastSeenSince ||
      filters.lastSeenUntil ||
      filters.sort !== "newest",
  );

  const exportParams = new URLSearchParams();
  if (filters.q) exportParams.set("q", filters.q);
  if (filters.role) exportParams.set("role", filters.role);
  if (filters.status) exportParams.set("status", filters.status);
  if (filters.since) exportParams.set("since", filters.since);
  if (filters.until) exportParams.set("until", filters.until);
  if (filters.lastSeenSince) exportParams.set("lastSeenSince", filters.lastSeenSince);
  if (filters.lastSeenUntil) exportParams.set("lastSeenUntil", filters.lastSeenUntil);

  function toggleSelected(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const allOnPageSelected = pageUsers.length > 0 && pageUsers.every((u) => selected.has(u.id));
  function toggleSelectAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        pageUsers.forEach((u) => next.delete(u.id));
      } else {
        pageUsers.forEach((u) => next.add(u.id));
      }
      return next;
    });
  }

  function copyTelegramId(telegramId: string) {
    void navigator.clipboard.writeText(telegramId);
    toast.success("Telegram ID copied.");
  }

  return (
    <PageLayout title="Customers">
      <PageHeader
        title="Customers"
        description="Browse and manage every registered customer and reseller."
        actions={
          <a href={`/api/users/export?${exportParams.toString()}`}>
            <Button variant="outline" size="sm">Export CSV</Button>
          </a>
        }
      />

      <CustomersKpiRow />

      <FilterBar onApply={applyFilters} onClear={clearFilters} className="mb-4">
        <SearchBar
          value={searchInput}
          onChange={setSearchInput}
          loading={isFetching && searchInput !== ""}
          placeholder="Search by name, username, Telegram ID…"
          className="w-full sm:w-[420px]"
        />

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Role</label>
          <Select
            value={draft.role || "_all_"}
            onValueChange={(v) => setDraft((f) => ({ ...f, role: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-36" aria-label="Role">
              <SelectValue placeholder="All roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {roles.map((r) => (
                <SelectItem key={r} value={r}>
                  {roleLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Status</label>
          <Select
            value={draft.status || "_all_"}
            onValueChange={(v) => setDraft((f) => ({ ...f, status: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-32" aria-label="Status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="banned">Banned</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Joined From</label>
          <DateInput
            value={draft.since}
            onChange={(e) => setDraft((f) => ({ ...f, since: e.target.value }))}
            className="w-36"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Joined To</label>
          <DateInput
            value={draft.until}
            onChange={(e) => setDraft((f) => ({ ...f, until: e.target.value }))}
            className="w-36"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Last Seen From</label>
          <DateInput
            value={draft.lastSeenSince}
            onChange={(e) => setDraft((f) => ({ ...f, lastSeenSince: e.target.value }))}
            className="w-36"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Last Seen To</label>
          <DateInput
            value={draft.lastSeenUntil}
            onChange={(e) => setDraft((f) => ({ ...f, lastSeenUntil: e.target.value }))}
            className="w-36"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Sort</label>
          <Select
            value={draft.sort}
            onValueChange={(v) => setDraft((f) => ({ ...f, sort: v }))}
          >
            <SelectTrigger className="w-48" aria-label="Sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SORT_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </FilterBar>

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
          <span className="text-ink-soft">{selected.size} selected</span>
          <a href={`/api/users/export?ids=${Array.from(selected).join(",")}`}>
            <Button size="sm" variant="ghost">Export</Button>
          </a>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <DataTable
        stickyHeader
        columns={[
          {
            key: "select",
            header: (
              <Checkbox
                checked={allOnPageSelected}
                onCheckedChange={toggleSelectAllOnPage}
                aria-label="Select all customers on this page"
              />
            ),
            render: (row) => (
              <Checkbox
                checked={selected.has(row.id)}
                onCheckedChange={() => toggleSelected(row.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select customer ${row.fullName ?? row.username ?? row.id}`}
              />
            ),
          },
          {
            key: "customer",
            header: "Customer",
            render: (row) => (
              <div className="flex items-center gap-3">
                <Avatar>
                  <AvatarFallback>{initialFor(row)}</AvatarFallback>
                </Avatar>
                <div>
                  <div className="text-sm font-medium text-ink">{primaryIdentity(row)}</div>
                  <div className="text-xs text-ink-soft">{secondaryIdentity(row)}</div>
                </div>
              </div>
            ),
          },
          {
            key: "telegramId",
            header: "Telegram ID",
            render: (row) => (
              <span className="font-mono text-xs text-ink-soft">{row.telegramId ?? "—"}</span>
            ),
          },
          {
            key: "role",
            header: "Role",
            render: (row) => <StatusBadge status={row.role} />,
          },
          {
            key: "status",
            header: "Status",
            render: (row) =>
              row.banned ? (
                <StatusBadge status="BANNED" />
              ) : isNewCustomer(row) ? (
                <StatusBadge status="NEW_CUSTOMER" />
              ) : row.deliveredOrders >= 2 ? (
                <StatusBadge status="RETURNING" />
              ) : null,
          },
          {
            key: "joined",
            header: "Joined",
            render: (row) => (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-ink-soft">
                    {formatRelativeTime(row.createdAt, row.createdAtDisplay ?? "—")}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{row.createdAtDisplay ?? "—"}</TooltipContent>
              </Tooltip>
            ),
          },
          {
            key: "lastSeen",
            header: "Last Seen",
            render: (row) =>
              row.lastSeenAt ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-xs text-ink-soft">
                      {formatRelativeTime(row.lastSeenAt, row.lastSeenAtDisplay ?? "—")}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{row.lastSeenAtDisplay ?? "—"}</TooltipContent>
                </Tooltip>
              ) : (
                <span className="text-xs text-ink-soft">—</span>
              ),
          },
          {
            key: "totalSpent",
            header: "Total Spent",
            render: (row) => {
              const amounts = nonZeroAmounts(row.totalSpent);
              return amounts.length > 0 ? (
                <CurrencyStack amounts={amounts} />
              ) : (
                <span className="text-xs text-ink-soft">—</span>
              );
            },
          },
          {
            key: "orders",
            header: "Orders",
            render: (row) => <span className="text-sm text-ink">{row.totalOrders}</span>,
          },
          {
            key: "lastOrder",
            header: "Last Order",
            render: (row) => (
              <span className="text-xs text-ink-soft">{row.lastOrderAtDisplay ?? "—"}</span>
            ),
          },
          {
            key: "actions",
            header: "",
            render: (row) => {
              const ordersTarget = targetForOrders(row);
              return (
                <div onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.fullName ?? row.username ?? row.id}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => navigate(`/users/${row.id}`)}>
                        <Eye className="h-4 w-4" />
                        View Customer
                      </DropdownMenuItem>
                      {ordersTarget != null && (
                        <DropdownMenuItem onSelect={() => navigate(`/orders?q=${encodeURIComponent(ordersTarget)}`)}>
                          <ShoppingBag className="h-4 w-4" />
                          View Orders
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => navigate(`/users/${row.id}#ledger`)}>
                        <Wallet className="h-4 w-4" />
                        Transactions
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => navigate(`/users/${row.id}#tickets`)}>
                        <LifeBuoy className="h-4 w-4" />
                        Support Tickets
                      </DropdownMenuItem>
                      {row.telegramId != null && (
                        <DropdownMenuItem onSelect={() => copyTelegramId(row.telegramId!)}>
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
              );
            },
          },
        ]}
        data={pageUsers}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => navigate(`/users/${row.id}`)}
        empty={
          hasActiveFilter ? (
            <EmptyState
              icon={Users}
              title="No customers match these filters."
              description="Try widening the date range or clearing a filter."
              action={{ label: "Refresh", onClick: () => void refetch() }}
              secondaryAction={{ label: "Clear Filters", onClick: clearFilters }}
            />
          ) : (
            <EmptyState
              icon={Users}
              title="No customers yet"
              description="Customers will appear here once they interact with the shop."
              action={{ label: "Refresh", onClick: () => void refetch() }}
            />
          )
        }
      />

      {data && (
        <div className="mt-4">
          <Pagination
            page={filters.page}
            pageSize={filters.pageSize}
            total={data.total}
            onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
            onPageSizeChange={(pageSize) => setFilters((f) => ({ ...f, pageSize, page: 1 }))}
          />
        </div>
      )}

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
