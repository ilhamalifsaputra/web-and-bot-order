import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { StatCard } from "../components/shared/StatCard";
import { Pagination } from "../components/shared/Pagination";
import { StatusBadge, statusLabel } from "../components/shared/StatusBadge";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { Button } from "@/components/ui/button";
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
} from "@/components/ui/dropdown-menu";
import {
  ClipboardList,
  MoreVertical,
  PlayCircle,
  CheckCircle2,
  ArrowUpCircle,
  Clock,
  UserCheck,
  AlertTriangle,
} from "lucide-react";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

const TYPE_VALUES = [
  "REQUEST_CUSTOMER_INFO",
  "MANUAL_DELIVERY",
  "MANUAL_ACCOUNT_ASSIGNMENT",
  "FAILED_TOPUP_REVIEW",
  "REFUND_REVIEW",
];
const STATUS_VALUES = ["PENDING", "ASSIGNED", "IN_PROGRESS", "ESCALATED", "COMPLETED"];
const PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

const ALL = "_all_";
// Not a UI-only sentinel like `ALL` — this is the literal value the backend's
// `buildAdminTaskFilter` (apps/web-admin/src/routes/api/adminTasks.ts) reads
// as `assignedTo=unassigned` (mirrors the crud layer's `AdminTaskFilter.
// assignedTo: "unassigned"`), so it flows straight into the query param with
// no translation step.
const UNASSIGNED = "unassigned";
// Controlled-value placeholder for the per-row Assignee <Select> when a task
// has no assignee yet — never rendered as a selectable SelectItem (there is
// no "unassign" action in ADMIN_TASK_LEGAL_TRANSITIONS, so picking "no admin"
// isn't a real choice here), it only satisfies Select's `value` prop; the
// visible text always comes from the explicit `SelectValue` child below.
const NO_ASSIGNEE = "_none_";

/**
 * Which of the four state-machine actions are legal from a given current
 * status — mirrors `ADMIN_TASK_LEGAL_TRANSITIONS` (packages/db/src/crud/
 * adminTasks.ts) 1:1 (assign->ASSIGNED, start->IN_PROGRESS,
 * complete->COMPLETED, escalate->ESCALATED). This client never imports from
 * `@app/db` (a server-only package), so it's re-derived here as a small,
 * purely cosmetic affordance — hiding actions the server would reject isn't a
 * security boundary, the route's own try/catch-ValidationError->422 is (this
 * list only needs to stay roughly in sync with that map to avoid a confusing
 * "greyed out for no reason"/"errors on click" UX, not to enforce anything).
 */
const LEGAL_ACTIONS_FROM: Record<string, Array<"assign" | "start" | "complete" | "escalate">> = {
  PENDING: ["assign", "escalate"],
  ASSIGNED: ["start", "escalate"],
  IN_PROGRESS: ["complete", "escalate"],
  ESCALATED: ["assign", "start", "complete"],
  COMPLETED: [],
};

function typeLabel(type: string): string {
  return statusLabel(type);
}

interface AdminOption {
  id: number | null;
  telegramId: number;
  name: string | null;
}

interface TaskOrderRef {
  id: number;
  orderCode: string;
}
interface TaskOrderItemRef {
  id: number;
  quantity: number;
  unitPrice: string;
}
interface TaskRefundRef {
  id: number;
  amount: string;
  currency: string;
  status: string;
}

interface TaskRow {
  id: number;
  type: string;
  status: string;
  priority: string;
  assignedTo: number | null;
  assigneeName: string | null;
  order: TaskOrderRef | null;
  orderItem: TaskOrderItemRef | null;
  refund: TaskRefundRef | null;
  dueAt: string | null;
  dueAtDisplay: string | null;
  completedAt: string | null;
  completedAtDisplay: string | null;
  createdAt: string;
  createdAtDisplay: string | null;
}

interface TaskStats {
  pending: number;
  assigned: number;
  inProgress: number;
  escalated: number;
}

interface TasksData {
  items: TaskRow[];
  total: number;
  page: number;
  pageSize: number;
  stats: TaskStats;
}

interface Filters {
  type: string;
  status: string;
  priority: string;
  assignedTo: string;
  page: number;
  pageSize: number;
}

const EMPTY_DRAFT = { type: "", status: "", priority: "", assignedTo: "" };
const DEFAULT_FILTERS: Filters = { ...EMPTY_DRAFT, page: 1, pageSize: 20 };

function useAdminTasks(filters: Filters) {
  return useQuery<TasksData>({
    queryKey: ["admin-tasks", filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.type) params.set("type", filters.type);
      if (filters.status) params.set("status", filters.status);
      if (filters.priority) params.set("priority", filters.priority);
      if (filters.assignedTo) params.set("assignedTo", filters.assignedTo);
      if (filters.page > 1) params.set("page", String(filters.page));
      if (filters.pageSize !== 20) params.set("pageSize", String(filters.pageSize));
      const res = await fetch(`/api/admin-tasks?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<TasksData>;
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

function referenceLabel(row: TaskRow): { text: string; href: string | null } {
  if (row.refund) {
    return {
      text: `Refund #${row.refund.id} — ${formatCurrencyDisplay(row.refund.amount, row.refund.currency as "IDR" | "USDT" | "USD")}`,
      href: row.order ? `/orders/${row.order.id}` : null,
    };
  }
  if (row.orderItem) {
    return {
      text: `${row.order?.orderCode ?? `Order #${row.order?.id ?? "?"}`} (item ×${row.orderItem.quantity})`,
      href: row.order ? `/orders/${row.order.id}` : null,
    };
  }
  if (row.order) {
    return { text: row.order.orderCode, href: `/orders/${row.order.id}` };
  }
  return { text: "—", href: null };
}

export function TasksPage() {
  const qc = useQueryClient();

  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [completeTarget, setCompleteTarget] = useState<number | null>(null);

  const { data, isError, refetch } = useAdminTasks(filters);
  const { data: adminsData } = useAdmins();

  const assignableAdmins = useMemo(
    () => (adminsData?.admins ?? []).filter((a): a is AdminOption & { id: number } => a.id !== null),
    [adminsData],
  );

  function invalidateAll() {
    void qc.invalidateQueries({ queryKey: ["admin-tasks"] });
  }

  const assign = useMutation({
    mutationFn: (vars: { taskId: number; from: string; assignedTo: number }) =>
      apiPost(`/api/admin-tasks/${vars.taskId}/assign`, { from: vars.from, assignedTo: vars.assignedTo }),
    onSuccess: () => {
      invalidateAll();
      toast.success("Task assigned.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const start = useMutation({
    mutationFn: (vars: { taskId: number; from: string }) =>
      apiPost(`/api/admin-tasks/${vars.taskId}/start`, { from: vars.from }),
    onSuccess: () => {
      invalidateAll();
      toast.success("Task started.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const complete = useMutation({
    mutationFn: (vars: { taskId: number; from: string }) =>
      apiPost(`/api/admin-tasks/${vars.taskId}/complete`, { from: vars.from }),
    onSuccess: () => {
      invalidateAll();
      toast.success("Task completed.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const escalate = useMutation({
    mutationFn: (vars: { taskId: number; from: string }) =>
      apiPost(`/api/admin-tasks/${vars.taskId}/escalate`, { from: vars.from }),
    onSuccess: () => {
      invalidateAll();
      toast.success("Task escalated.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  if (isError) {
    return (
      <PageLayout title="Tasks">
        <p className="text-sm text-rust">Failed to load tasks.</p>
      </PageLayout>
    );
  }

  const items = data?.items ?? [];

  function applyFilters() {
    setFilters((f) => ({ ...f, ...draft, page: 1 }));
  }

  function clearFilters() {
    setDraft(EMPTY_DRAFT);
    setFilters(DEFAULT_FILTERS);
  }

  const hasActiveFilter = Boolean(filters.type || filters.status || filters.priority || filters.assignedTo);

  return (
    <PageLayout title="Tasks">
      <PageHeader
        title="Tasks"
        description="Manual operations queue: manual deliveries, account assignments, failed top-up and refund reviews."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Pending" value={data?.stats.pending ?? 0} icon={Clock} isLoading={!data} />
        <StatCard label="Assigned" value={data?.stats.assigned ?? 0} icon={UserCheck} isLoading={!data} />
        <StatCard label="In Progress" value={data?.stats.inProgress ?? 0} icon={PlayCircle} isLoading={!data} />
        <StatCard
          label="Escalated"
          value={data?.stats.escalated ?? 0}
          icon={AlertTriangle}
          tone="danger"
          isLoading={!data}
        />
      </div>

      <FilterBar onApply={applyFilters} onClear={clearFilters} className="mb-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Type</label>
          <Select
            value={draft.type || ALL}
            onValueChange={(v) => setDraft((d) => ({ ...d, type: v === ALL ? "" : v }))}
          >
            <SelectTrigger className="w-52" aria-label="Type filter">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              {TYPE_VALUES.map((t) => (
                <SelectItem key={t} value={t}>
                  {typeLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Status</label>
          <Select
            value={draft.status || ALL}
            onValueChange={(v) => setDraft((d) => ({ ...d, status: v === ALL ? "" : v }))}
          >
            <SelectTrigger className="w-40" aria-label="Status filter">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              {STATUS_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Priority</label>
          <Select
            value={draft.priority || ALL}
            onValueChange={(v) => setDraft((d) => ({ ...d, priority: v === ALL ? "" : v }))}
          >
            <SelectTrigger className="w-40" aria-label="Priority filter">
              <SelectValue placeholder="All priorities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              {PRIORITY_VALUES.map((p) => (
                <SelectItem key={p} value={p}>
                  {statusLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Assignee</label>
          <Select
            value={draft.assignedTo || ALL}
            onValueChange={(v) => setDraft((d) => ({ ...d, assignedTo: v === ALL ? "" : v }))}
          >
            <SelectTrigger className="w-44" aria-label="Assignee filter">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
              {assignableAdmins.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.name ?? `Telegram ID ${a.telegramId}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </FilterBar>

      <DataTable
        stickyHeader
        columns={[
          {
            key: "task",
            header: "Task",
            render: (row) => (
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-xs text-ink-soft">#{row.id}</span>
                <span className="text-sm text-ink">{typeLabel(row.type)}</span>
              </div>
            ),
          },
          {
            key: "priority",
            header: "Priority",
            render: (row) => <StatusBadge status={row.priority} />,
          },
          {
            key: "status",
            header: "Status",
            render: (row) => <StatusBadge status={row.status} />,
          },
          {
            key: "assignee",
            header: "Assignee",
            render: (row) => {
              const canAssign = (LEGAL_ACTIONS_FROM[row.status] ?? []).includes("assign");
              if (!canAssign) {
                return <span className="text-sm text-ink-soft">{row.assigneeName ?? "Unassigned"}</span>;
              }
              return (
                <div onClick={(e) => e.stopPropagation()}>
                  <Select
                    value={row.assignedTo !== null ? String(row.assignedTo) : NO_ASSIGNEE}
                    onValueChange={(v) => {
                      if (v === NO_ASSIGNEE) return;
                      assign.mutate({ taskId: row.id, from: row.status, assignedTo: Number(v) });
                    }}
                  >
                    <SelectTrigger className="w-40" aria-label={`Assignee for task #${row.id}`}>
                      <SelectValue>{row.assigneeName ?? "Unassigned"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {assignableAdmins.length === 0 ? (
                        <SelectItem value={NO_ASSIGNEE} disabled>
                          No admins available
                        </SelectItem>
                      ) : (
                        assignableAdmins.map((a) => (
                          <SelectItem key={a.id} value={String(a.id)}>
                            {a.name ?? `Telegram ID ${a.telegramId}`}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
              );
            },
          },
          {
            key: "reference",
            header: "Reference",
            render: (row) => {
              const ref = referenceLabel(row);
              return ref.href ? (
                <Link
                  to={ref.href}
                  onClick={(e) => e.stopPropagation()}
                  className="font-mono text-xs text-pine hover:underline"
                >
                  {ref.text}
                </Link>
              ) : (
                <span className="text-xs text-ink-soft">{ref.text}</span>
              );
            },
          },
          {
            key: "due",
            header: "Due",
            render: (row) => <span className="text-xs text-ink-soft">{row.dueAtDisplay ?? "—"}</span>,
          },
          {
            key: "created",
            header: "Created",
            render: (row) => <span className="text-xs text-ink-soft">{row.createdAtDisplay ?? "—"}</span>,
          },
          {
            key: "actions",
            header: "",
            render: (row) => {
              const legal = LEGAL_ACTIONS_FROM[row.status] ?? [];
              if (legal.length === 0) {
                return null;
              }
              return (
                <div onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for task #${row.id}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {legal.includes("start") && (
                        <DropdownMenuItem onSelect={() => start.mutate({ taskId: row.id, from: row.status })}>
                          <PlayCircle className="h-4 w-4" />
                          Start
                        </DropdownMenuItem>
                      )}
                      {legal.includes("complete") && (
                        <DropdownMenuItem
                          onSelect={(e) => {
                            e.preventDefault();
                            setCompleteTarget(row.id);
                          }}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          Complete
                        </DropdownMenuItem>
                      )}
                      {legal.includes("escalate") && (
                        <DropdownMenuItem onSelect={() => escalate.mutate({ taskId: row.id, from: row.status })}>
                          <ArrowUpCircle className="h-4 w-4" />
                          Escalate
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            },
          },
        ]}
        data={items}
        isLoading={!data}
        keyExtractor={(row) => row.id}
        empty={
          hasActiveFilter ? (
            <EmptyState
              icon={ClipboardList}
              title="No matching tasks"
              description="Try a different filter."
              action={{ label: "Refresh", onClick: () => void refetch() }}
              secondaryAction={{ label: "Clear Filters", onClick: clearFilters }}
            />
          ) : (
            <EmptyState
              icon={ClipboardList}
              title="No admin tasks"
              description="Manual-operations tasks (deliveries, account assignments, top-up and refund reviews) will appear here."
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

      {completeTarget !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setCompleteTarget(null);
          }}
          title="Complete this task?"
          description="This marks the task done. It won't reappear in the active queue."
          confirmLabel="Complete"
          variant="default"
          onConfirm={() => {
            const row = items.find((t) => t.id === completeTarget);
            if (row) complete.mutate({ taskId: row.id, from: row.status });
          }}
        />
      )}
    </PageLayout>
  );
}
