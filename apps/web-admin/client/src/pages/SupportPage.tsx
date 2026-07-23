import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { UrgencyDot } from "../components/shared/UrgencyDot";
import { Pagination } from "../components/shared/Pagination";
import { DateInput } from "../components/shared/DateInput";
import { TicketsKpiRow } from "./support/TicketsKpiRow";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  MessageCircle,
  MoreVertical,
  Eye,
  UserPlus,
  CheckCircle2,
  XCircle,
  RefreshCw,
  User,
  ShoppingCart,
  Copy,
} from "lucide-react";
import { useAdmins, type AdminRow } from "../hooks/useAdmins";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface TicketUser {
  id: number;
  fullName: string | null;
  username: string | null;
  telegramId: string | null;
}

interface TicketAdmin {
  id: number;
  fullName: string | null;
  username: string | null;
}

interface Ticket {
  id: number;
  userId: number;
  subject: string;
  status: string;
  priority: string;
  category: string | null;
  adminId: number | null;
  createdAtDisplay: string | null;
  waitingSince: string | null;
  isOverdue: boolean;
  user: TicketUser;
  admin: TicketAdmin | null;
}

interface TicketsData {
  tickets: Ticket[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  statuses: string[];
  priorities: string[];
  categories: string[];
}

interface BulkActionResult {
  succeeded: number[];
  failed: { id: number; error: string }[];
}

interface Filters {
  status: string;
  priority: string;
  category: string;
  /** "" = all, "unassigned" = adminId is null, else a numeric admin id as a string. */
  assignedAdminId: string;
  q: string;
  since: string;
  until: string;
  page: number;
  pageSize: number;
}

const UNASSIGNED = "_unassigned_";

/** "PAYMENT" -> "Payment", "HIGH" -> "High" — for filter/select option labels. */
function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

/** First letter of the name shown for this row — full name, else username,
 * else "?" for the rare row with neither. */
function initialFor(user: TicketUser): string {
  const source = user.fullName ?? user.username;
  return source && source.length > 0 ? source[0]!.toUpperCase() : "?";
}

const OPEN_STATUSES = new Set(["OPEN", "REPLIED"]);
function canResolveTicket(row: Ticket): boolean {
  return OPEN_STATUSES.has(row.status);
}
function canCloseTicket(row: Ticket): boolean {
  return row.status !== "CLOSED";
}

function useTickets(filters: Filters) {
  return useQuery<TicketsData>({
    queryKey: ["support", filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.priority) params.set("priority", filters.priority);
      if (filters.category) params.set("category", filters.category);
      if (filters.assignedAdminId) params.set("assignedAdminId", filters.assignedAdminId);
      if (filters.q) params.set("q", filters.q);
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      if (filters.page > 1) params.set("page", String(filters.page));
      if (filters.pageSize !== 20) params.set("pageSize", String(filters.pageSize));
      const res = await fetch(`/api/support?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<TicketsData>;
    },
  });
}

export function SupportPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState({
    status: "",
    priority: "",
    category: "",
    assignedAdminId: "",
    q: "",
    since: "",
    until: "",
  });
  const [filters, setFilters] = useState<Filters>({
    status: "",
    priority: "",
    category: "",
    assignedAdminId: "",
    q: "",
    since: "",
    until: "",
    page: 1,
    pageSize: 20,
  });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [assignTarget, setAssignTarget] = useState<{ ids: number[] } | null>(null);
  const [assignAdminId, setAssignAdminId] = useState(UNASSIGNED);

  const { data, isLoading, isError, refetch } = useTickets(filters);
  const { data: adminsData } = useAdmins();

  // Only admins with a User row (id !== null) can be the target of the
  // adminId FK on SupportTicket — filter those out of the pick list (mirrors
  // the prior version of this page and AdminsPage's own convention).
  const assignableAdmins = useMemo(
    () => (adminsData?.admins ?? []).filter((a): a is AdminRow & { id: number } => a.id !== null),
    [adminsData],
  );
  const adminNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const a of assignableAdmins) map.set(a.id, a.name ?? `Telegram ID ${a.telegramId}`);
    return map;
  }, [assignableAdmins]);

  // A stale selection surviving a new page/filter result set would let a
  // bulk action silently apply to rows no longer on screen — clear it
  // whenever the query changes.
  useEffect(() => {
    setSelected(new Set());
  }, [filters]);

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ["support"] });
  }

  const resolveMutation = useMutation({
    mutationFn: (ticketId: number) => apiPost(`/api/support/${ticketId}/resolve`, {}),
    onSuccess: () => {
      invalidateAll();
      toast.success("Ticket resolved.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const closeMutation = useMutation({
    mutationFn: (ticketId: number) => apiPost(`/api/support/${ticketId}/close`, {}),
    onSuccess: () => {
      invalidateAll();
      toast.success("Ticket closed.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const reopenMutation = useMutation({
    mutationFn: (ticketId: number) => apiPost(`/api/support/${ticketId}/reopen`, {}),
    onSuccess: () => {
      invalidateAll();
      toast.success("Ticket reopened.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const bulkMutation = useMutation({
    mutationFn: (vars: { ids: number[]; action: "resolve" | "close" }) =>
      apiPost<BulkActionResult>("/api/support/bulk-action", vars),
    onSuccess: (result) => {
      invalidateAll();
      setSelected(new Set());
      toast.success(`${result.succeeded.length} succeeded, ${result.failed.length} failed.`);
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  // Single-ticket assign uses the dedicated /assign route (audit reads
  // "ticket_assign"); a multi-id selection goes through /bulk-action (logs
  // one "ticket_bulk_assign" summary row instead) — same Dialog drives both,
  // the response is normalized to the bulk shape either way so the toast
  // copy doesn't need to branch (mirrors OrdersPage's cancel dialog).
  const assignMutation = useMutation({
    mutationFn: async (vars: { ids: number[]; adminId: number | null }): Promise<BulkActionResult> => {
      if (vars.ids.length === 1) {
        await apiPost(`/api/support/${vars.ids[0]}/assign`, { adminId: vars.adminId });
        return { succeeded: vars.ids, failed: [] };
      }
      return apiPost<BulkActionResult>("/api/support/bulk-action", {
        ids: vars.ids,
        action: "assign",
        adminId: vars.adminId,
      });
    },
    onSuccess: (result) => {
      invalidateAll();
      setSelected(new Set());
      setAssignTarget(null);
      toast.success(
        result.failed.length > 0
          ? `${result.succeeded.length} succeeded, ${result.failed.length} failed.`
          : result.succeeded.length > 1
            ? `${result.succeeded.length} tickets assigned.`
            : "Ticket assigned.",
      );
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  if (isError) {
    return (
      <PageLayout title="Tickets">
        <p className="text-rust">Failed to load tickets.</p>
      </PageLayout>
    );
  }

  const statuses = data?.statuses ?? [];
  const priorities = data?.priorities ?? [];
  const categories = data?.categories ?? [];
  const pageTickets = data?.tickets ?? [];

  function applyFilters() {
    setFilters((f) => ({
      ...f,
      status: draft.status,
      priority: draft.priority,
      category: draft.category,
      assignedAdminId: draft.assignedAdminId,
      q: draft.q,
      since: draft.since,
      until: draft.until,
      page: 1,
    }));
  }

  function clearFilters() {
    setDraft({ status: "", priority: "", category: "", assignedAdminId: "", q: "", since: "", until: "" });
    setFilters({
      status: "",
      priority: "",
      category: "",
      assignedAdminId: "",
      q: "",
      since: "",
      until: "",
      page: 1,
      pageSize: 20,
    });
  }

  const hasActiveFilter = Boolean(
    filters.status ||
      filters.priority ||
      filters.category ||
      filters.assignedAdminId ||
      filters.q ||
      filters.since ||
      filters.until,
  );

  function toggleSelected(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const allOnPageSelected = pageTickets.length > 0 && pageTickets.every((t) => selected.has(t.id));
  function toggleSelectAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        pageTickets.forEach((t) => next.delete(t.id));
      } else {
        pageTickets.forEach((t) => next.add(t.id));
      }
      return next;
    });
  }

  function eligibleSelectedIds(predicate: (row: Ticket) => boolean): number[] {
    return pageTickets.filter((t) => selected.has(t.id) && predicate(t)).map((t) => t.id);
  }

  function runBulk(action: "resolve" | "close", predicate: (row: Ticket) => boolean, ineligibleMessage: string) {
    const ids = eligibleSelectedIds(predicate);
    if (ids.length === 0) {
      toast.error(ineligibleMessage);
      return;
    }
    bulkMutation.mutate({ ids, action });
  }

  function openAssignDialog(ids: number[], currentAdminId: number | null = null) {
    setAssignTarget({ ids });
    setAssignAdminId(currentAdminId !== null ? String(currentAdminId) : UNASSIGNED);
  }

  function confirmAssign() {
    if (!assignTarget) return;
    const adminId = assignAdminId === UNASSIGNED ? null : Number(assignAdminId);
    assignMutation.mutate({ ids: assignTarget.ids, adminId });
  }

  return (
    <PageLayout title="Tickets">
      <PageHeader title="Tickets" description="Triage, assign and resolve customer support tickets." />

      <TicketsKpiRow />

      <FilterBar onApply={applyFilters} onClear={clearFilters} className="mb-4">
        <SearchBar
          value={draft.q}
          onChange={(v) => setDraft((f) => ({ ...f, q: v }))}
          placeholder="Search message or customer..."
          className="w-full sm:w-[360px]"
        />

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Status</label>
          <Select
            value={draft.status || "_all_"}
            onValueChange={(v) => setDraft((f) => ({ ...f, status: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {statuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Priority</label>
          <Select
            value={draft.priority || "_all_"}
            onValueChange={(v) => setDraft((f) => ({ ...f, priority: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="All priorities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {priorities.map((p) => (
                <SelectItem key={p} value={p}>
                  {titleCase(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Category</label>
          <Select
            value={draft.category || "_all_"}
            onValueChange={(v) => setDraft((f) => ({ ...f, category: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {titleCase(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Assigned To</label>
          <Select
            value={draft.assignedAdminId || "_all_"}
            onValueChange={(v) => setDraft((f) => ({ ...f, assignedAdminId: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Anyone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">Anyone</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {assignableAdmins.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.name ?? `Telegram ID ${a.telegramId}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">From</label>
          <DateInput
            value={draft.since}
            onChange={(e) => setDraft((f) => ({ ...f, since: e.target.value }))}
            className="w-36"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">To</label>
          <DateInput
            value={draft.until}
            onChange={(e) => setDraft((f) => ({ ...f, until: e.target.value }))}
            className="w-36"
          />
        </div>
      </FilterBar>

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
          <span className="text-ink-soft">{selected.size} selected</span>
          <Button
            size="sm"
            variant="outline"
            disabled={assignMutation.isPending}
            onClick={() => openAssignDialog(Array.from(selected))}
          >
            Assign
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkMutation.isPending}
            onClick={() => runBulk("resolve", canResolveTicket, "None of the selected tickets can be resolved.")}
          >
            Resolve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkMutation.isPending}
            onClick={() => runBulk("close", canCloseTicket, "None of the selected tickets can be closed.")}
          >
            Close
          </Button>
          <a href={`/api/support/export?ids=${Array.from(selected).join(",")}`}>
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
            key: "priority",
            header: "Priority",
            render: (row) => <StatusBadge status={row.priority} />,
          },
          {
            key: "customer",
            header: "Customer",
            render: (row) => (
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pine text-xs font-semibold text-white">
                  {initialFor(row.user)}
                </div>
                <div>
                  <div className="text-sm text-ink">{row.user.fullName ?? row.user.username ?? "—"}</div>
                  <div className="text-xs text-ink-soft">{row.user.username ? `@${row.user.username}` : ""}</div>
                </div>
              </div>
            ),
          },
          {
            key: "subject",
            header: "Subject",
            render: (row) => (
              <div className="truncate max-w-xs" title={row.subject}>
                {row.subject}
              </div>
            ),
          },
          {
            key: "status",
            header: "Status",
            render: (row) => <StatusBadge status={row.status} />,
          },
          {
            key: "assigned",
            header: "Assigned",
            render: (row) => (
              <span className="text-sm text-ink-soft">
                {row.admin?.fullName ?? row.admin?.username ?? "Unassigned"}
              </span>
            ),
          },
          {
            key: "waiting",
            header: "Waiting",
            render: (row) => (
              <div className="flex items-center gap-2">
                <span className="text-xs text-ink-soft">{row.waitingSince ?? "—"}</span>
                {row.isOverdue && <UrgencyDot level="critical" />}
              </div>
            ),
          },
          {
            key: "category",
            header: "Category",
            render: (row) => <span className="text-sm text-ink-soft">{row.category ?? "Uncategorized"}</span>,
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
                      View Ticket
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        openAssignDialog([row.id], row.adminId);
                      }}
                    >
                      <UserPlus className="h-4 w-4" />
                      Assign
                    </DropdownMenuItem>
                    {canResolveTicket(row) && (
                      <DropdownMenuItem onSelect={() => resolveMutation.mutate(row.id)}>
                        <CheckCircle2 className="h-4 w-4" />
                        Resolve
                      </DropdownMenuItem>
                    )}
                    {canCloseTicket(row) && (
                      <DropdownMenuItem onSelect={() => closeMutation.mutate(row.id)}>
                        <XCircle className="h-4 w-4" />
                        Close
                      </DropdownMenuItem>
                    )}
                    {row.status === "CLOSED" && (
                      <DropdownMenuItem onSelect={() => reopenMutation.mutate(row.id)}>
                        <RefreshCw className="h-4 w-4" />
                        Reopen
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => navigate(`/users/${row.userId}`)}>
                      <User className="h-4 w-4" />
                      Customer Profile
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        navigate(`/orders?q=${encodeURIComponent(row.user.username ?? String(row.user.telegramId))}`)
                      }
                    >
                      <ShoppingCart className="h-4 w-4" />
                      Order History
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        void navigator.clipboard.writeText(String(row.id));
                        toast.success("Ticket ID copied.");
                      }}
                    >
                      <Copy className="h-4 w-4" />
                      Copy Ticket ID
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ),
          },
        ]}
        data={pageTickets}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => navigate(`/support/${row.id}`)}
        empty={
          <EmptyState
            icon={MessageCircle}
            title="No open tickets."
            description="Everything is up to date. New support requests will appear here."
            action={{ label: "Refresh", onClick: () => void refetch() }}
            secondaryAction={hasActiveFilter ? { label: "Clear Filters", onClick: clearFilters } : undefined}
          />
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

      {assignTarget && (
        <Dialog open onOpenChange={(open) => { if (!open) setAssignTarget(null); }}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>
                {assignTarget.ids.length > 1 ? `Assign ${assignTarget.ids.length} tickets?` : "Assign this ticket?"}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-ink-soft">Admin</label>
              <Select value={assignAdminId} onValueChange={setAssignAdminId}>
                <SelectTrigger aria-label="Assignee">
                  <SelectValue>
                    {assignAdminId !== UNASSIGNED
                      ? (adminNameById.get(Number(assignAdminId)) ?? `Admin #${assignAdminId}`)
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
            <DialogFooter>
              <Button variant="outline" onClick={() => setAssignTarget(null)}>Back</Button>
              <Button disabled={assignMutation.isPending} onClick={confirmAssign}>
                {assignMutation.isPending ? "Assigning…" : "Confirm"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PageLayout>
  );
}
