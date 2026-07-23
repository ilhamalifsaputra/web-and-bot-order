import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { StatusBadge } from "../components/shared/StatusBadge";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { AssignTicketDialog } from "../components/shared/AssignTicketDialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Send, CircleX, CheckCircle2, RefreshCw, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";
import { useAdmins, type AdminRow } from "../hooks/useAdmins";

// Client mirrors of `packages/core/src/enums.ts`'s TicketPriority/TicketCategory
// (never cross-imports @app/core enums — same convention as OrderStatusBadge).
const PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const CATEGORY_VALUES = ["ORDER", "PAYMENT", "ACCOUNT", "PRODUCT", "OTHER"];
/** Sentinel for the Category Select's "no category" option — bridges to the
 *  API's `category: null`. */
const NO_CATEGORY = "_none_";

/** "PAYMENT" -> "Payment", "HIGH" -> "High" — for select option labels. */
function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

const OPEN_STATUSES = new Set(["OPEN", "REPLIED"]);

interface TicketDetail {
  ticket: {
    id: number;
    subject: string;
    status: string;
    priority: string;
    category: string | null;
    adminId: number | null;
    admin: { id: number; fullName: string | null; username: string | null } | null;
    createdAt: string;
  };
  messages: { id: number; content: string; senderType: string; createdAt: string; createdAtDisplay: string | null }[];
  user: { id: number; fullName: string | null; username: string | null } | null;
}

function useTicket(ticketId: string) {
  return useQuery<TicketDetail>({
    queryKey: ["ticket", ticketId],
    queryFn: async () => {
      const res = await fetch(`/api/support/${ticketId}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<TicketDetail>;
    },
  });
}

export function TicketDetailPage() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isError } = useTicket(ticketId ?? "");
  const { data: adminsData } = useAdmins();
  const [reply, setReply] = useState("");
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignAdminId, setAssignAdminId] = useState<number | null>(null);

  // Only admins with a User row (id !== null) can be the target of the
  // adminId FK on SupportTicket — same filter as SupportPage's picker.
  const assignableAdmins = useMemo(
    () => (adminsData?.admins ?? []).filter((a): a is AdminRow & { id: number } => a.id !== null),
    [adminsData],
  );
  const assignableAdminOptions = useMemo(
    () => assignableAdmins.map((a) => ({ id: a.id, name: a.name ?? `Telegram ID ${a.telegramId}` })),
    [assignableAdmins],
  );

  function invalidateTicket() {
    void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
    // Also refresh the queue list/KPIs so a stale count/row isn't left behind
    // for whenever the admin navigates back to /support.
    void qc.invalidateQueries({ queryKey: ["support"] });
  }

  const sendReply = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/reply`, { content: reply }),
    onSuccess: () => {
      invalidateTicket();
      setReply("");
      toast.success("Reply sent.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const close = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/close`, {}),
    onSuccess: () => {
      invalidateTicket();
      toast.success("Ticket closed.");
      navigate("/support");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const resolveMutation = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/resolve`, {}),
    onSuccess: () => {
      invalidateTicket();
      toast.success("Ticket resolved.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const reopenMutation = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/reopen`, {}),
    onSuccess: () => {
      invalidateTicket();
      toast.success("Ticket reopened.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const classifyMutation = useMutation({
    mutationFn: (vars: { priority?: string; category?: string | null }) =>
      apiPost(`/api/support/${ticketId}/classify`, vars),
    onSuccess: () => {
      invalidateTicket();
      toast.success("Ticket classification updated.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const assignMutation = useMutation({
    mutationFn: (adminId: number | null) => apiPost(`/api/support/${ticketId}/assign`, { adminId }),
    onSuccess: () => {
      invalidateTicket();
      setAssignOpen(false);
      toast.success("Ticket assigned.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  if (isError) return <PageLayout title="Ticket"><p className="text-sm text-rust">Failed to load ticket.</p></PageLayout>;
  if (!data) return <PageLayout title="Ticket"><p>Loading…</p></PageLayout>;

  const { ticket, messages, user } = data;
  const canResolve = OPEN_STATUSES.has(ticket.status);
  const isClosed = ticket.status === "CLOSED";
  const assignedName = ticket.admin?.fullName ?? ticket.admin?.username ?? null;

  function openAssignDialog() {
    setAssignAdminId(ticket.adminId);
    setAssignOpen(true);
  }

  return (
    <PageLayout title={`Ticket #${ticket.id}`}>
      <PageHeader
        title={`Ticket #${ticket.id}: ${ticket.subject}`}
        breadcrumb={[{ label: "Support", href: "/support" }]}
      />

      {/* Ticket meta */}
      <div className="mb-4 flex flex-wrap gap-3 items-center text-sm">
        <StatusBadge status={ticket.status} />
        <span className="text-ink-soft">Customer: <span className="text-ink">{user?.fullName ?? user?.username ?? "Unknown"}</span></span>
      </div>

      {/* Triage: priority/category classification + assignment */}
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Priority</label>
          <Select
            value={ticket.priority}
            onValueChange={(v) => classifyMutation.mutate({ priority: v })}
          >
            <SelectTrigger aria-label="Priority" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_VALUES.map((p) => (
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
            value={ticket.category ?? NO_CATEGORY}
            onValueChange={(v) => classifyMutation.mutate({ category: v === NO_CATEGORY ? null : v })}
          >
            <SelectTrigger aria-label="Category" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CATEGORY}>Uncategorized</SelectItem>
              {CATEGORY_VALUES.map((c) => (
                <SelectItem key={c} value={c}>
                  {titleCase(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button variant="outline" onClick={openAssignDialog}>
          <UserPlus className="h-4 w-4" />
          {assignedName ?? "Assign"}
        </Button>
      </div>

      {/* Message thread */}
      <div className="flex flex-col gap-3 mb-6">
        {messages.map(m => (
          <div
            key={m.id}
            className={`rounded-lg border-l-2 px-4 py-3 ${
              m.senderType === "ADMIN"
                ? "border-pine bg-pine-tint"
                : "border-line bg-sand"
            }`}
          >
            <div className="mb-1 text-xs text-ink-soft">
              {m.senderType === "ADMIN" ? "Admin" : "Customer"} — {m.createdAtDisplay ?? "—"}
            </div>
            <div className="text-sm text-ink whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
      </div>

      {/* Reply + status actions */}
      <Card>
        <CardHeader><CardTitle>{isClosed ? "Ticket Closed" : "Reply"}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!isClosed && (
            <Textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              placeholder="Write a reply…"
              rows={4}
            />
          )}
          <div className="flex flex-wrap gap-2">
            {!isClosed && (
              <Button onClick={() => sendReply.mutate()} disabled={!reply || sendReply.isPending}>
                <Send className="h-4 w-4" />
                {sendReply.isPending ? "Saving…" : "Send Reply"}
              </Button>
            )}
            {canResolve && (
              <ConfirmDialog
                trigger={<Button variant="outline"><CheckCircle2 className="h-4 w-4" />Resolve</Button>}
                title="Resolve this ticket?"
                description="The ticket will be marked resolved. The customer can still reply to reopen the conversation."
                confirmLabel="Resolve"
                variant="default"
                onConfirm={() => resolveMutation.mutate()}
              />
            )}
            {!isClosed && (
              <ConfirmDialog
                trigger={<Button variant="destructive"><CircleX className="h-4 w-4" />Close Ticket</Button>}
                title="Close this ticket?"
                description="The ticket will be marked as closed and no further replies can be added."
                confirmLabel="Close"
                onConfirm={() => close.mutate()}
              />
            )}
            {isClosed && (
              <ConfirmDialog
                trigger={<Button variant="default"><RefreshCw className="h-4 w-4" />Reopen</Button>}
                title="Reopen this ticket?"
                description="The ticket will be moved back to Open and can be replied to again."
                confirmLabel="Reopen"
                variant="default"
                onConfirm={() => reopenMutation.mutate()}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <AssignTicketDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        ticketCount={1}
        admins={assignableAdminOptions}
        value={assignAdminId}
        onValueChange={setAssignAdminId}
        onConfirm={() => assignMutation.mutate(assignAdminId)}
        isPending={assignMutation.isPending}
      />
    </PageLayout>
  );
}
