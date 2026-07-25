import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { StatCard } from "../components/shared/StatCard";
import { Pagination } from "../components/shared/Pagination";
import { TicketStatusBadge } from "../components/shared/TicketStatusBadge";
import { TicketPriorityBadge } from "../components/shared/TicketPriorityBadge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  MessageCircle,
  MoreVertical,
  Eye,
  UserCog,
  XCircle,
  Clock,
  AlertTriangle,
  UserX,
  CheckCircle2,
} from "lucide-react";
import { ticketStatusLabel } from "../lib/ticketStatus";
import { ticketPriorityLabel } from "../lib/ticketPriority";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface TicketUser {
  id: number;
  fullName: string | null;
  username: string | null;
}

// No `subject` field — the Ticket column shows a truncated `message` excerpt
// instead (Task 3 dropped `subject`; the old SupportPage.tsx's use of it was
// the bug this rewrite fixes).
interface TicketRow {
  id: number;
  userId: number;
  message: string;
  status: string;
  priority: string;
  adminId: number | null;
  createdAt: string;
  createdAtDisplay: string | null;
  repliedAt: string | null;
  repliedAtDisplay: string | null;
  isOverdue: boolean;
  user: TicketUser | null;
}

interface TicketStats {
  open: number;
  waitingCustomer: number;
  overdue: number;
  unassigned: number;
  resolvedToday: number;
}

interface SupportData {
  items: TicketRow[];
  total: number;
  page: number;
  pageSize: number;
  stats: TicketStats;
}

interface AdminOption {
  id: number | null;
  telegramId: number;
  name: string | null;
}

interface BulkActionResult {
  succeeded: number[];
  failed: { id: number; error: string }[];
}

interface Filters {
  status: string;
  priority: string;
  assigned: string;
  sort: string;
  page: number;
  pageSize: number;
}

const UNASSIGNED = "_unassigned_";
const ALL_STATUSES = "_all_";
const ALL_PRIORITIES = "_all_";
const ALL_ASSIGNED = "_all_";
const STATUS_VALUES = ["OPEN", "REPLIED", "CLOSED"];
const PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const DEFAULT_SORT = "newest";

function useTickets(q: string, filters: Filters) {
  return useQuery<SupportData>({
    queryKey: ["support", q, filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (filters.status) params.set("status", filters.status);
      if (filters.priority) params.set("priority", filters.priority);
      if (filters.assigned) params.set("assigned", filters.assigned);
      if (filters.sort) params.set("sort", filters.sort);
      if (filters.page > 1) params.set("page", String(filters.page));
      if (filters.pageSize !== 20) params.set("pageSize", String(filters.pageSize));
      const res = await fetch(`/api/support?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<SupportData>;
    },
    refetchInterval: 30_000,
  });
}

function useAdmins() {
  return useQuery<{ admins: AdminOption[] }>({
    queryKey: ["admins"],
    queryFn: async () => {
      const res = await fetch("/api/admins");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<{ admins: AdminOption[] }>;
    },
  });
}

function customerLabel(user: TicketUser | null): string {
  return user?.fullName ?? user?.username ?? "a customer";
}

export function SupportPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [qDraft, setQDraft] = useState("");
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState({ status: "", priority: "", assigned: "", sort: DEFAULT_SORT });
  const [filters, setFilters] = useState<Filters>({
    status: "",
    priority: "",
    assigned: "",
    sort: DEFAULT_SORT,
    page: 1,
    pageSize: 20,
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(qDraft);
      // Bail out to the *same* object reference when page is already 1 —
      // unlike Vouchers'/Orders' plain-number page state (where setPage(1)
      // naturally no-ops via Object.is when already 1), `filters` is an
      // object, so `{ ...f, page: 1 }` would otherwise always mint a new
      // reference even when nothing changed. That new reference re-fires
      // the `[q, filters]` effect below (which clears `selected`) on every
      // debounce tick — including the one that always fires 300ms after
      // mount — silently wiping out an in-progress bulk selection.
      setFilters((f) => (f.page === 1 ? f : { ...f, page: 1 }));
    }, 300);
    return () => clearTimeout(timer);
  }, [qDraft]);

  const { data, isError, refetch } = useTickets(q, filters);
  // Super-admin-only data source (mirrors AdminsPage) — a non-super admin
  // simply won't see assignee names/options here; the Assigned controls
  // still work off ticket.adminId for the "assigned" state (same convention
  // the previous SupportPage.tsx used).
  const { data: adminsData } = useAdmins();

  const assignableAdmins = useMemo(
    () => (adminsData?.admins ?? []).filter((a): a is AdminOption & { id: number } => a.id !== null),
    [adminsData],
  );
  const adminNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const a of assignableAdmins) map.set(a.id, a.name ?? `Telegram ID ${a.telegramId}`);
    return map;
  }, [assignableAdmins]);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hoveredMessageId, setHoveredMessageId] = useState<number | null>(null);
  const [closeTarget, setCloseTarget] = useState<number | null>(null);

  // A stale selection surviving a new page/filter result set would let a
  // bulk action silently apply to rows no longer on screen — clear it
  // whenever the query changes (mirrors OrdersPage.tsx). Also resets the
  // live-update toast baseline (below) so switching filters/pages doesn't
  // read as a burst of "new ticket" arrivals.
  //
  // Live-update toast: snapshot the last successful fetch's {id -> status},
  // then on every subsequent successful fetch (including the 30s poll) diff
  // against it — toast for tickets that are newly present (new ticket) or
  // whose status changed since the last snapshot. No precedent to copy
  // verbatim; kept self-contained here. Reset to null whenever the
  // filter/page changes (below), so a fresh view establishes its own
  // baseline instead of toasting for every row already on screen.
  const previousStatusesRef = useRef<Map<number, string> | null>(null);

  useEffect(() => {
    setSelected(new Set());
    previousStatusesRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filters]);

  useEffect(() => {
    if (!data) return;
    const prev = previousStatusesRef.current;
    if (prev) {
      for (const item of data.items) {
        const prevStatus = prev.get(item.id);
        if (prevStatus === undefined) {
          toast(`New ticket #${item.id} from ${customerLabel(item.user)}`);
        } else if (prevStatus !== item.status) {
          toast(`Ticket #${item.id} status changed to ${ticketStatusLabel(item.status)}`);
        }
      }
    }
    previousStatusesRef.current = new Map(data.items.map((item) => [item.id, item.status]));
  }, [data]);

  function invalidateAll() {
    void qc.invalidateQueries({ queryKey: ["support"] });
  }

  /** Pre-seed the diffing ref for ids this page itself just closed, so the
   *  refetch that `invalidateAll()` triggers doesn't ALSO read as a status
   *  change and fire a duplicate "Ticket #N status changed to Closed" toast
   *  on top of the mutation's own "Ticket closed."/"Closed N tickets."
   *  success toast. Only closing needs this: assign/priority mutations don't
   *  touch `status`, so they can never trigger the diffing effect's status
   *  branch in the first place. A ticket genuinely closed by a *different*
   *  admin (not seeded here) still surfaces its diff-toast normally. */
  function markClosedInRef(ids: number[]) {
    const ref = previousStatusesRef.current;
    if (!ref) return;
    for (const id of ids) ref.set(id, "CLOSED");
  }

  const assign = useMutation({
    mutationFn: ({ ticketId, adminId }: { ticketId: number; adminId: number | null }) =>
      apiPost(`/api/support/${ticketId}/assign`, { adminId }),
    onSuccess: () => {
      invalidateAll();
      toast.success("Ticket assigned.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const close = useMutation({
    mutationFn: (ticketId: number) => apiPost(`/api/support/${ticketId}/close`, {}),
    onSuccess: (_result, ticketId) => {
      markClosedInRef([ticketId]);
      invalidateAll();
      toast.success("Ticket closed.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const bulkAction = useMutation({
    mutationFn: (vars: {
      ids: number[];
      action: "assign" | "close" | "priority";
      adminId?: number | null;
      priority?: string;
    }) => apiPost<BulkActionResult>("/api/support/bulk-action", vars),
    onSuccess: (result, vars) => {
      if (vars.action === "close") markClosedInRef(result.succeeded);
      invalidateAll();
      setSelected(new Set());
      const verb =
        vars.action === "assign" ? "Assigned" : vars.action === "close" ? "Closed" : "Updated priority for";
      toast.success(
        result.failed.length > 0
          ? `${verb} ${result.succeeded.length} of ${vars.ids.length} tickets — ${result.failed.length} skipped.`
          : `${verb} ${result.succeeded.length} ticket${result.succeeded.length === 1 ? "" : "s"}.`,
      );
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  if (isError) {
    return (
      <PageLayout title="Support">
        <p className="text-sm text-rust">Failed to load tickets.</p>
      </PageLayout>
    );
  }

  const items = data?.items ?? [];
  const allOnPageSelected = items.length > 0 && items.every((t) => selected.has(t.id));

  function toggleSelected(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleSelectAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) items.forEach((t) => next.delete(t.id));
      else items.forEach((t) => next.add(t.id));
      return next;
    });
  }

  function applyFilters() {
    setFilters((f) => ({
      ...f,
      status: draft.status,
      priority: draft.priority,
      assigned: draft.assigned,
      sort: draft.sort,
      page: 1,
    }));
  }

  function clearFilters() {
    setDraft({ status: "", priority: "", assigned: "", sort: DEFAULT_SORT });
    setQDraft("");
    setQ("");
    setFilters({ status: "", priority: "", assigned: "", sort: DEFAULT_SORT, page: 1, pageSize: 20 });
  }

  const hasActiveFilter = Boolean(
    filters.status || filters.priority || filters.assigned || filters.sort !== DEFAULT_SORT || q,
  );

  return (
    <PageLayout title="Support">
      <PageHeader
        title="Support"
        description="Manage customer support tickets, assignments and escalations."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Open" value={data?.stats.open ?? 0} icon={MessageCircle} isLoading={!data} />
        <StatCard label="Waiting Customer" value={data?.stats.waitingCustomer ?? 0} icon={Clock} isLoading={!data} />
        <StatCard
          label="Overdue"
          value={data?.stats.overdue ?? 0}
          icon={AlertTriangle}
          tone="danger"
          isLoading={!data}
        />
        <StatCard label="Unassigned" value={data?.stats.unassigned ?? 0} icon={UserX} isLoading={!data} />
        <StatCard
          label="Resolved Today"
          value={data?.stats.resolvedToday ?? 0}
          icon={CheckCircle2}
          tone="success"
          isLoading={!data}
        />
      </div>

      <FilterBar onApply={applyFilters} onClear={clearFilters} className="mb-4">
        <SearchBar
          value={qDraft}
          onChange={setQDraft}
          placeholder="Search ticket message or customer..."
          className="w-full sm:w-64"
        />

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Status</label>
          <Select
            value={draft.status || ALL_STATUSES}
            onValueChange={(v) => setDraft((d) => ({ ...d, status: v === ALL_STATUSES ? "" : v }))}
          >
            <SelectTrigger className="w-40" aria-label="Status filter">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>All</SelectItem>
              {STATUS_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {ticketStatusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Priority</label>
          <Select
            value={draft.priority || ALL_PRIORITIES}
            onValueChange={(v) => setDraft((d) => ({ ...d, priority: v === ALL_PRIORITIES ? "" : v }))}
          >
            <SelectTrigger className="w-40" aria-label="Priority filter">
              <SelectValue placeholder="All priorities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PRIORITIES}>All</SelectItem>
              {PRIORITY_VALUES.map((p) => (
                <SelectItem key={p} value={p}>
                  {ticketPriorityLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Assigned</label>
          <Select
            value={draft.assigned || ALL_ASSIGNED}
            onValueChange={(v) => setDraft((d) => ({ ...d, assigned: v === ALL_ASSIGNED ? "" : v }))}
          >
            <SelectTrigger className="w-40" aria-label="Assigned filter">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ASSIGNED}>All</SelectItem>
              <SelectItem value="assigned">Assigned</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Sort</label>
          <Select value={draft.sort} onValueChange={(v) => setDraft((d) => ({ ...d, sort: v }))}>
            <SelectTrigger className="w-40" aria-label="Sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="oldest">Oldest</SelectItem>
              <SelectItem value="priority">Priority</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </FilterBar>

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
          <span className="text-ink-soft">{selected.size} selected</span>

          <Select
            onValueChange={(v) =>
              bulkAction.mutate({
                ids: Array.from(selected),
                action: "assign",
                adminId: v === UNASSIGNED ? null : Number(v),
              })
            }
          >
            <SelectTrigger className="w-44" aria-label="Assign selected tickets to">
              <SelectValue placeholder="Assign to…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
              {assignableAdmins.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.name ?? `Telegram ID ${a.telegramId}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            onValueChange={(v) =>
              bulkAction.mutate({ ids: Array.from(selected), action: "priority", priority: v })
            }
          >
            <SelectTrigger className="w-40" aria-label="Set priority for selected tickets">
              <SelectValue placeholder="Set priority…" />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_VALUES.map((p) => (
                <SelectItem key={p} value={p}>
                  {ticketPriorityLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <ConfirmDialog
            trigger={
              <Button size="sm" variant="destructive" disabled={bulkAction.isPending}>
                Close {selected.size} ticket{selected.size === 1 ? "" : "s"}
              </Button>
            }
            title={`Close ${selected.size} ticket${selected.size === 1 ? "" : "s"}?`}
            description="Customers will no longer be able to reply through these tickets."
            confirmLabel="Close"
            onConfirm={() => bulkAction.mutate({ ids: Array.from(selected), action: "close" })}
          />

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
                disabled={items.length === 0}
                aria-label="Select all tickets on this page"
              />
            ),
            render: (row) => (
              <Checkbox
                checked={selected.has(row.id)}
                onCheckedChange={() => toggleSelected(row.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ticket #${row.id}`}
              />
            ),
          },
          {
            key: "ticket",
            header: "Ticket",
            render: (row) => (
              <Popover
                open={hoveredMessageId === row.id}
                onOpenChange={(open) => setHoveredMessageId(open ? row.id : null)}
              >
                <PopoverTrigger asChild>
                  <div
                    className="flex max-w-[240px] cursor-default flex-col items-start gap-0.5"
                    onMouseEnter={() => setHoveredMessageId(row.id)}
                    onMouseLeave={() => setHoveredMessageId((id) => (id === row.id ? null : id))}
                  >
                    <span className="font-mono text-xs text-ink-soft">#{row.id}</span>
                    <span className="line-clamp-1 text-sm text-ink">{row.message}</span>
                  </div>
                </PopoverTrigger>
                <PopoverContent className="max-w-sm text-sm whitespace-pre-wrap">{row.message}</PopoverContent>
              </Popover>
            ),
          },
          {
            key: "customer",
            header: "Customer",
            render: (row) => (
              <div>
                <div className="text-sm text-ink">{row.user?.fullName ?? row.user?.username ?? "—"}</div>
                {row.user?.username && row.user.fullName && (
                  <div className="text-xs text-ink-soft">@{row.user.username}</div>
                )}
              </div>
            ),
          },
          {
            key: "priority",
            header: "Priority",
            render: (row) => <TicketPriorityBadge priority={row.priority} />,
          },
          {
            key: "status",
            header: "Status",
            render: (row) => (
              <div className="flex flex-wrap items-center gap-1.5">
                <TicketStatusBadge status={row.status} />
                {row.isOverdue && <Badge variant="destructive">Overdue</Badge>}
              </div>
            ),
          },
          {
            key: "assigned",
            header: "Assigned",
            render: (row) => (
              // Stop the click from bubbling to the row's onRowClick (which
              // navigates to the ticket detail page) — covers both the
              // trigger button and item picks inside the portaled dropdown.
              <div onClick={(e) => e.stopPropagation()}>
                <Select
                  value={row.adminId !== null ? String(row.adminId) : UNASSIGNED}
                  onValueChange={(v) =>
                    assign.mutate({ ticketId: row.id, adminId: v === UNASSIGNED ? null : Number(v) })
                  }
                >
                  <SelectTrigger className="w-40" aria-label={`Assignee for ticket #${row.id}`}>
                    <SelectValue>
                      {row.adminId !== null
                        ? (adminNameById.get(row.adminId) ?? `Admin #${row.adminId}`)
                        : "Unassigned"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {assignableAdmins.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name ?? `Telegram ID ${a.telegramId}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ),
          },
          {
            key: "date",
            header: "Date",
            render: (row) => <span className="text-xs text-ink-soft">{row.createdAtDisplay ?? "—"}</span>,
          },
          {
            key: "actions",
            header: "",
            render: (row) => (
              <div onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ticket #${row.id}`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => navigate(`/support/${row.id}`)}>
                      <Eye className="h-4 w-4" />
                      View
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <UserCog className="h-4 w-4" />
                        Assign
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuItem onSelect={() => assign.mutate({ ticketId: row.id, adminId: null })}>
                          Unassigned
                        </DropdownMenuItem>
                        {assignableAdmins.map((a) => (
                          <DropdownMenuItem
                            key={a.id}
                            onSelect={() => assign.mutate({ ticketId: row.id, adminId: a.id })}
                          >
                            {a.name ?? `Telegram ID ${a.telegramId}`}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    {row.status !== "CLOSED" && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={(e) => {
                            e.preventDefault();
                            setCloseTarget(row.id);
                          }}
                        >
                          <XCircle className="h-4 w-4" />
                          Close
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ),
          },
        ]}
        data={items}
        isLoading={!data}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => navigate(`/support/${row.id}`)}
        empty={
          hasActiveFilter ? (
            <EmptyState
              icon={MessageCircle}
              title="No matching tickets"
              description="Try a different search or filter."
              action={{ label: "Refresh", onClick: () => void refetch() }}
              secondaryAction={{ label: "Clear Filters", onClick: clearFilters }}
            />
          ) : (
            <EmptyState
              icon={MessageCircle}
              title="No support tickets"
              description="Customer support tickets will appear here as customers create them."
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
            pageSizeOptions={[20, 50, 100]}
          />
        </div>
      )}

      {closeTarget !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setCloseTarget(null);
          }}
          title="Close this ticket?"
          description="The customer will no longer be able to reply through this ticket."
          confirmLabel="Close"
          onConfirm={() => {
            if (closeTarget !== null) close.mutate(closeTarget);
          }}
        />
      )}
    </PageLayout>
  );
}
