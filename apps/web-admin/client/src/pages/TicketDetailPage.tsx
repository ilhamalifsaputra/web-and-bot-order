import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { CardRow } from "../components/shared/CardRow";
import { CurrencyStack } from "../components/shared/CurrencyAmount";
import { TicketStatusBadge } from "../components/shared/TicketStatusBadge";
import { TicketPriorityBadge } from "../components/shared/TicketPriorityBadge";
import type { OrderUnitsData } from "../components/orders/OrderUnitsCard";
import { TicketConversation, type ConversationMessage } from "../components/support/TicketConversation";
import {
  TicketIssueContext,
  type LinkedUnitsState,
  type TicketOrder,
} from "../components/support/TicketIssueContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Send, CircleX, CheckCircle2, RotateCcw, Lock, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, type ApiError } from "../api/client";
import { describeError } from "../lib/errorMessages";
import { ticketPriorityLabel } from "../lib/ticketPriority";
import { buildTicketActivity, type TicketActivityRow, type TicketActivityEntry } from "../lib/ticketActivity";
import { describeTicketCustomer, type TicketCustomerUser } from "../lib/ticketCustomer";

const PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const CATEGORY_VALUES = ["ORDER", "PAYMENT", "ACCOUNT", "PRODUCT", "OTHER"];
const UNCATEGORIZED = "_uncategorized_";
const UNASSIGNED = "_unassigned_";

function categoryLabel(category: string): string {
  return category.charAt(0) + category.slice(1).toLowerCase();
}

/** `ticketNumber` is null for every ticket created before it existed —
 * those historical rows fall back to the old `#id` label. */
function ticketDisplayLabel(ticket: { id: number; ticketNumber: string | null }): string {
  return ticket.ticketNumber ?? `#${ticket.id}`;
}

interface Ticket {
  id: number;
  ticketNumber: string | null;
  userId: number;
  /** Always set: the stored subject, or one derived from the message. */
  subject: string;
  /** The customer's original complaint — the first message of the conversation. */
  message: string;
  photoFileIds: string | null;
  status: string;
  priority: string;
  category: string | null;
  adminId: number | null;
  assignedAt: string | null;
  assignedAtDisplay: string | null;
  assignedBy: number | null;
  createdAt: string;
  createdAtDisplay: string | null;
  createdAtShort: string | null;
  orderId: number | null;
  order: TicketOrder | null;
}

interface TicketMessageRow {
  id: number;
  content: string;
  senderType: string;
  /** User id of the sender — for an ADMIN message, the admin's User row. */
  senderId?: number | null;
  internal: boolean;
  createdAt: string;
  createdAtDisplay: string | null;
  createdAtShort: string | null;
  photoFileIds: string | null;
}

interface CustomerContext {
  totalSpent: { idr: string; usdt: string };
  orderCount: number;
  openTicketCount: number;
}

interface TicketDetail {
  ticket: Ticket;
  messages: TicketMessageRow[];
  user: TicketCustomerUser | null;
  customer: CustomerContext;
  /** Both newest first. */
  timeline: { ticket: TicketActivityRow[]; order: TicketActivityRow[] };
}

interface AdminOption {
  id: number | null;
  telegramId: number;
  name: string | null;
}

function useTicket(ticketId: string) {
  return useQuery<TicketDetail>({
    queryKey: ["ticket", ticketId],
    queryFn: () => apiGet<TicketDetail>(`/api/support/${ticketId}`),
  });
}

// Same source/shape as SupportPage.tsx's useAdmins(). Super-admin only
// (requireSuper): anyone else sees the `Admin #<id>` / "Admin" fallbacks.
function useAdmins() {
  return useQuery<{ admins: AdminOption[] }>({
    queryKey: ["admins"],
    queryFn: () => apiGet<{ admins: AdminOption[] }>("/api/admins"),
  });
}

/**
 * The linked order's admin detail, for the per-unit replacement list (M20).
 *
 * Deliberately the SAME query key and route the order detail page uses, so the
 * two share one cache entry and a replacement opened from either surface
 * invalidates both. `ticket.order` carries only a summary — no per-unit stock
 * row, delivered flag or replacement history.
 *
 * GET /api/orders/:orderId is gated to non-readonly roles (blockReadonlyReads):
 * a readonly admin gets a 403, which the page treats as "not shown" rather
 * than an error. Any other failure offers a retry.
 *
 * NOTE ON CREDENTIALS: that route returns each unit's `stockItem.credentials`,
 * so the delivered credentials DO arrive in this page's React Query cache even
 * though `showCredentials={false}` never renders them. That is a presentation
 * choice, not a fetch scope; if this page must not see them, the route needs a
 * projection.
 */
function useLinkedOrderUnits(orderId: number | null) {
  return useQuery<OrderUnitsData>({
    queryKey: ["order", String(orderId)],
    queryFn: () => apiGet<OrderUnitsData>(`/api/orders/${orderId}`),
    enabled: orderId !== null,
    // No automatic retries: a readonly role's 403 is permanent (retrying only
    // keeps the skeleton up for seconds), and any other failure shows its own
    // Retry button.
    retry: false,
  });
}

/** Up to `max` Telegram photo `file_id`s parsed from a CSV column. */
function parsePhotoIds(csv: string | null, max = 3): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

function TicketDetailSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading ticket">
      <div className="mb-6 flex flex-col gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
        <div className="mt-2 flex flex-wrap gap-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-40" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-4/5" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </CardContent>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardContent className="flex flex-col gap-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function TicketDetailPage() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isError } = useTicket(ticketId ?? "");
  const { data: adminsData } = useAdmins();
  const linkedOrder = useLinkedOrderUnits(data?.ticket.orderId ?? null);
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);

  const adminNameById = new Map<number, string>();
  for (const a of adminsData?.admins ?? []) {
    if (a.id !== null) adminNameById.set(a.id, a.name ?? `Telegram ID ${a.telegramId}`);
  }
  // A CUSTOMER-actor row (the ticket_create row, a customer's own order
  // action) has adminId: null just like a true system entry — it must still
  // say the customer acted, not "System".
  function actorLabel(row: TicketActivityRow): string {
    if (row.actorType === "CUSTOMER") return "Customer";
    if (row.adminId === null) return "System";
    return adminNameById.get(row.adminId) ?? `Admin #${row.adminId}`;
  }
  // Plain admin-id → name for `ticket.adminId`/`ticket.assignedBy` — always a
  // genuine admin id (or null meaning "unset"), never a customer actor.
  function adminLabel(adminId: number | null): string {
    if (adminId === null) return "System";
    return adminNameById.get(adminId) ?? `Admin #${adminId}`;
  }
  const assignableAdmins = (adminsData?.admins ?? []).filter(
    (a): a is AdminOption & { id: number } => a.id !== null,
  );

  const sendReply = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/reply`, { content: reply, internal }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      setReply("");
      setInternal(false);
      setReplyError(null);
    },
    onError: (e: Error) => setReplyError(e.message),
  });

  // Same POST /api/support/:ticketId/assign route SupportPage's assignee
  // Select posts to; both stamp assignedAt/assignedBy.
  const assign = useMutation({
    mutationFn: (nextAdminId: number | null) =>
      apiPost(`/api/support/${ticketId}/assign`, { adminId: nextAdminId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toast.success("Ticket assigned.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const close = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/close`, {}),
    onSuccess: () => {
      toast.success("Ticket closed.");
      navigate("/support");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const setPriority = useMutation({
    mutationFn: (priority: string) => apiPost(`/api/support/${ticketId}/priority`, { priority }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toast.success("Priority updated.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const setCategory = useMutation({
    mutationFn: (category: string | null) => apiPost(`/api/support/${ticketId}/classify`, { category }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toast.success("Category updated.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const resolve = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/resolve`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toast.success("Ticket marked resolved.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const reopen = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/reopen`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toast.success("Ticket reopened.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  if (isError) return <PageLayout title="Ticket"><p className="text-sm text-rust">Failed to load ticket.</p></PageLayout>;
  if (!data) return <PageLayout title="Ticket"><TicketDetailSkeleton /></PageLayout>;

  const { ticket, messages, user, customer, timeline } = data;
  const ticketLabel = ticketDisplayLabel(ticket);
  const isClosed = ticket.status === "CLOSED";

  // The original complaint lives on the ticket itself, not in `messages`, so
  // it is shown as the conversation's first message.
  const conversation: ConversationMessage[] = [
    {
      key: "ticket",
      sender: "Customer",
      fromAdmin: false,
      internal: false,
      time: ticket.createdAtShort ?? ticket.createdAtDisplay ?? "",
      timeTitle: ticket.createdAtDisplay ?? "",
      content: ticket.message,
      photoIds: parsePhotoIds(ticket.photoFileIds),
    },
    ...messages.map((m) => {
      const fromAdmin = m.senderType === "ADMIN";
      return {
        key: `message-${m.id}`,
        sender: fromAdmin ? ((m.senderId != null ? adminNameById.get(m.senderId) : undefined) ?? "Admin") : "Customer",
        fromAdmin,
        internal: m.internal === true,
        time: m.createdAtShort ?? m.createdAtDisplay ?? "",
        timeTitle: m.createdAtDisplay ?? "",
        content: m.content,
        photoIds: parsePhotoIds(m.photoFileIds),
      };
    }),
  ];

  const activity: TicketActivityEntry[] = buildTicketActivity(timeline.ticket, { ticketLabel, actorLabel });
  if (!timeline.ticket.some((row) => row.action === "ticket_create")) {
    activity.unshift({
      id: -1,
      time: ticket.createdAtShort ?? ticket.createdAtDisplay ?? "",
      timeTitle: ticket.createdAtDisplay ?? "",
      text: "Ticket created",
    });
  }

  const orderActivity = timeline.order.map((row) => ({
    id: row.id,
    time: row.createdAtShort ?? row.createdAtDisplay ?? "",
    timeTitle: row.createdAtDisplay ?? "",
    actor: actorLabel(row),
    text: row.details ?? row.action,
  }));

  const linkedOrderError = linkedOrder.error as ApiError | null;
  const unitsState: LinkedUnitsState = linkedOrder.data
    ? { kind: "ready", data: linkedOrder.data }
    : linkedOrder.isError
      ? linkedOrderError?.status === 403
        ? { kind: "hidden" }
        : { kind: "error", onRetry: () => void linkedOrder.refetch(), retrying: linkedOrder.isFetching }
      : { kind: "loading" };

  const identity = describeTicketCustomer(user);

  const composer = isClosed ? null : (
    <div className="flex flex-col gap-3">
      {replyError && <p className="text-sm text-rust">{replyError}</p>}
      <Textarea
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        placeholder="Write a reply…"
        aria-label="Reply"
        rows={4}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Internal note: stored and audited, never sent to the customer,
            and it does not advance the ticket's status. */}
        <label className="flex items-center gap-2">
          <Checkbox
            checked={internal}
            onCheckedChange={(c) => setInternal(c === true)}
            aria-label="Internal note (not visible to the customer)"
          />
          <span className="text-sm text-ink">Internal note (not visible to the customer)</span>
        </label>
        <Button onClick={() => sendReply.mutate()} disabled={!reply || sendReply.isPending}>
          {internal ? <Lock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          {sendReply.isPending ? "Saving…" : internal ? "Save internal note" : "Send reply"}
        </Button>
      </div>
    </div>
  );

  return (
    <PageLayout title={`Ticket ${ticketLabel}`}>
      <PageHeader
        title={`Ticket ${ticketLabel}`}
        description={<span className="break-words">{ticket.subject}</span>}
        breadcrumb={[{ label: "Support", href: "/support" }]}
        actions={
          <>
            {/* Mirrors the backend's resolveTicket guard (status NOT IN
                [RESOLVED, CLOSED]). */}
            {ticket.status !== "RESOLVED" && !isClosed && (
              <Button variant="outline" onClick={() => resolve.mutate()} disabled={resolve.isPending}>
                <CheckCircle2 className="h-4 w-4" />
                Resolve
              </Button>
            )}
            {isClosed && (
              <Button variant="outline" onClick={() => reopen.mutate()} disabled={reopen.isPending}>
                <RotateCcw className="h-4 w-4" />
                Reopen
              </Button>
            )}
            {!isClosed && (
              <ConfirmDialog
                trigger={<Button variant="ghost"><CircleX className="h-4 w-4" />Close ticket</Button>}
                title="Close this ticket?"
                description="The ticket will be marked as closed and no further replies can be added."
                confirmLabel="Close"
                onConfirm={() => close.mutate()}
              />
            )}
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <TicketStatusBadge status={ticket.status} />
        <Select
          value={ticket.priority}
          onValueChange={(v) => setPriority.mutate(v)}
          disabled={setPriority.isPending}
        >
          <SelectTrigger className="w-full sm:w-36" aria-label="Ticket priority">
            <SelectValue>
              <TicketPriorityBadge priority={ticket.priority} />
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PRIORITY_VALUES.map((p) => (
              <SelectItem key={p} value={p}>
                {ticketPriorityLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={ticket.category ?? UNCATEGORIZED}
          onValueChange={(v) => setCategory.mutate(v === UNCATEGORIZED ? null : v)}
          disabled={setCategory.isPending}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Ticket category">
            <SelectValue>
              {ticket.category ? categoryLabel(ticket.category) : "Not categorized"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNCATEGORIZED}>Not categorized</SelectItem>
            {CATEGORY_VALUES.map((c) => (
              <SelectItem key={c} value={c}>
                {categoryLabel(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <span className="shrink-0 text-sm text-ink-soft">Assignee:</span>
          <Select
            value={ticket.adminId !== null ? String(ticket.adminId) : UNASSIGNED}
            onValueChange={(v) => assign.mutate(v === UNASSIGNED ? null : Number(v))}
            disabled={assign.isPending}
          >
            <SelectTrigger className="min-w-0 flex-1 sm:w-48 sm:flex-none" aria-label="Ticket assignee">
              <SelectValue>
                {ticket.adminId !== null ? adminLabel(ticket.adminId) : "Unassigned"}
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
        {ticket.adminId !== null && ticket.assignedAt && (
          <span className="text-xs text-ink-soft">
            Assigned by {adminLabel(ticket.assignedBy)}
            {ticket.assignedAtDisplay ? ` · ${ticket.assignedAtDisplay}` : ""}
          </span>
        )}
      </div>

      {/* DOM order is the mobile order: conversation, issue context, customer,
          activity. On lg the first two form the left column. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <TicketConversation
            messages={conversation}
            onPreviewPhoto={setPreviewFileId}
            composer={composer}
            closedNote="This ticket is closed. Reopen it to reply."
          />
          {ticket.order && (
            <TicketIssueContext
              ticketId={ticket.id}
              order={ticket.order}
              orderActivity={orderActivity}
              units={unitsState}
            />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle as="h2">Customer</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              <div className="text-sm font-medium break-words text-ink">{identity.name}</div>
              <div className="flex flex-col divide-y divide-line">
                {identity.identifiers.map((id) => (
                  <CardRow
                    key={id.label}
                    label={id.label}
                    value={<span className="break-all">{id.value}</span>}
                  />
                ))}
                <CardRow label="Orders" value={customer.orderCount} />
                <CardRow
                  label="Total spent"
                  value={
                    <CurrencyStack
                      amounts={[
                        { currency: "IDR", value: customer.totalSpent.idr },
                        { currency: "USDT", value: customer.totalSpent.usdt },
                      ]}
                    />
                  }
                />
                <CardRow label="Open tickets" value={customer.openTicketCount} />
              </div>
              {user && (
                <Link to={`/users/${ticket.userId}`} className="mt-2 w-fit text-sm text-pine hover:underline">
                  View customer profile →
                </Link>
              )}
            </CardContent>
          </Card>

          <Card>
            <details className="group">
              <summary className="mx-4 flex cursor-pointer list-none items-center justify-between gap-2 rounded-md font-heading text-base font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
                <span>Activity ({activity.length})</span>
                <ChevronDown className="h-4 w-4 text-ink-soft transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <ol className="mx-4 mt-3 flex flex-col divide-y divide-line">
                {activity.map((entry) => (
                  <li key={entry.id} data-testid="activity-entry" className="flex flex-col gap-0.5 py-2 text-sm">
                    <div className="break-words text-ink">
                      <span className="text-ink-soft" title={entry.timeTitle}>{entry.time}</span>
                      {" · "}
                      {entry.text}
                    </div>
                    {entry.statusTo && <div className="text-xs text-ink-soft">Status → {entry.statusTo}</div>}
                  </li>
                ))}
              </ol>
              {activity.length <= 1 && (
                <p className="mx-4 text-sm text-ink-soft">No additional activity yet.</p>
              )}
            </details>
          </Card>
        </div>
      </div>

      <Dialog open={previewFileId !== null} onOpenChange={(open) => { if (!open) setPreviewFileId(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>Attachment</DialogTitle>
          {previewFileId && (
            <img src={`/api/support/photo/${previewFileId}`} alt="Attachment preview" className="w-full rounded-lg" />
          )}
        </DialogContent>
      </Dialog>
    </PageLayout>
  );
}
