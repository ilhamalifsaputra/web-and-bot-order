import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { FilterBar } from "../components/shared/FilterBar";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { apiPost } from "../api/client";

interface Ticket {
  id: number;
  subject: string;
  status: string;
  adminId: number | null;
  createdAt: string;
  user?: { fullName: string | null; username: string | null };
}

interface AdminOption {
  id: number | null;
  telegramId: number;
  name: string | null;
}

const UNASSIGNED = "_unassigned_";
const ALL_STATUSES = "_all_";

function useTickets() {
  return useQuery<{ tickets: Ticket[] }>({
    queryKey: ["support"],
    queryFn: async () => {
      const res = await fetch("/api/support");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<{ tickets: Ticket[] }>;
    },
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

export function SupportPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isError } = useTickets();
  // Super-admin-only data source (mirrors AdminsPage) — a non-super admin
  // simply won't see assignee names/options here; the dropdown itself still
  // works off ticket.adminId for the "assigned" state.
  const { data: adminsData } = useAdmins();
  const [statusFilter, setStatusFilter] = useState("");

  // Only admins with a User row (id !== null) can be the target of the
  // adminId FK on SupportTicket — filter those out of the pick list.
  const assignableAdmins = useMemo(
    () => (adminsData?.admins ?? []).filter((a): a is AdminOption & { id: number } => a.id !== null),
    [adminsData],
  );
  const adminNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const a of assignableAdmins) map.set(a.id, a.name ?? `Telegram ID ${a.telegramId}`);
    return map;
  }, [assignableAdmins]);

  const assign = useMutation({
    mutationFn: ({ ticketId, adminId }: { ticketId: number; adminId: number | null }) =>
      apiPost(`/api/support/${ticketId}/assign`, { adminId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["support"] }); },
    onError: (e: Error) => alert(e.message),
  });

  if (isError) return <PageLayout title="Support"><p className="text-sm text-rust">Failed to load tickets.</p></PageLayout>;

  const tickets = data?.tickets ?? [];
  const statuses = Array.from(new Set(tickets.map(t => t.status)));
  const filteredTickets = statusFilter ? tickets.filter(t => t.status === statusFilter) : tickets;

  return (
    <PageLayout title="Support">
      <PageHeader title="Support" />

      <FilterBar className="mb-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Status</label>
          <Select
            value={statusFilter || ALL_STATUSES}
            onValueChange={v => setStatusFilter(v === ALL_STATUSES ? "" : v)}
          >
            <SelectTrigger className="w-40" aria-label="Status filter"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>All</SelectItem>
              {statuses.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </FilterBar>

      <DataTable
        columns={[
          {
            key: "id",
            header: "#",
            render: t => <span className="font-mono text-sm">{t.id}</span>,
          },
          {
            key: "subject",
            header: "Subject",
            render: t => t.subject,
          },
          {
            key: "customer",
            header: "Customer",
            render: t => t.user?.fullName ?? t.user?.username ?? "—",
          },
          {
            key: "status",
            header: "Status",
            render: t => <StatusBadge status={t.status} />,
          },
          {
            key: "assigned",
            header: "Assigned",
            render: t => (
              // Stop the click from bubbling to the row's onRowClick (which
              // navigates to the ticket detail page) — this covers both the
              // trigger button and item picks inside the portaled dropdown,
              // since React bubbles synthetic events along the component
              // tree, not the DOM tree the portal renders into.
              <div onClick={e => e.stopPropagation()}>
                <Select
                  value={t.adminId !== null ? String(t.adminId) : UNASSIGNED}
                  onValueChange={v =>
                    assign.mutate({ ticketId: t.id, adminId: v === UNASSIGNED ? null : Number(v) })
                  }
                >
                  <SelectTrigger className="w-40" aria-label={`Assignee for ticket #${t.id}`}>
                    <SelectValue>
                      {t.adminId !== null ? (adminNameById.get(t.adminId) ?? `Admin #${t.adminId}`) : "Unassigned"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {assignableAdmins.map(a => (
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
            render: t => (
              <span className="text-xs text-ink-soft">
                {new Date(t.createdAt).toLocaleDateString()}
              </span>
            ),
          },
        ]}
        data={filteredTickets}
        isLoading={!data}
        keyExtractor={t => t.id}
        onRowClick={t => navigate(`/support/${t.id}`)}
        empty={<EmptyState title="No open tickets" description="All support tickets will appear here." />}
      />
    </PageLayout>
  );
}
