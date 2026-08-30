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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Send, CircleX, CheckCircle2, RotateCcw, Lock } from "lucide-react";
import { toast } from "sonner";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";
import { ticketPriorityLabel } from "../lib/ticketPriority";

const PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const CATEGORY_VALUES = ["ORDER", "PAYMENT", "ACCOUNT", "PRODUCT", "OTHER"];
const UNCATEGORIZED = "_uncategorized_";
const UNASSIGNED = "_unassigned_";

function categoryLabel(category: string): string {
  return category.charAt(0) + category.slice(1).toLowerCase();
}

/** Task 3: `ticketNumber` (Task 1) is null for every ticket created before
 * that migration shipped — historical rows fall back to the old `#id`
 * label so they never render blank. */
function ticketDisplayLabel(ticket: { id: number; ticketNumber: string | null }): string {
  return ticket.ticketNumber ?? `#${ticket.id}`;
}

interface TicketOrderItem {
  id: number;
  quantity: number;
  unitPrice: string;
  product: { id: number; name: string };
}

interface TicketOrder {
  id: number;
  orderCode: string;
  createdAt: string;
  createdAtDisplay: string | null;
  items: TicketOrderItem[];
  voucher: { code: string; type: string } | null;
}

// No `subject` field — SupportTicket has no such column. The ticket's own
// short text is `message` (the initial submission); the thread itself lives
// in `messages` below.
interface Ticket {
  id: number;
  ticketNumber: string | null;
  userId: number;
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
  orderId: number | null;
  order: TicketOrder | null;
}

interface TicketMessageRow {
  id: number;
  content: string;
  senderType: string;
  internal: boolean;
  createdAt: string;
  createdAtDisplay: string | null;
  photoFileIds: string | null;
}

interface CustomerContext {
  totalSpent: { idr: string; usdt: string };
  orderCount: number;
  openTicketCount: number;
}

interface AuditLogRow {
  id: number;
  adminId: number | null;
  // "ADMIN" | "CUSTOMER" (Phase H, customer-action audit trail) — may be
  // absent on older/mocked fixtures, treated the same as "ADMIN".
  actorType?: string;
  action: string;
  details: string | null;
  createdAt: string;
  createdAtDisplay: string | null;
}

interface TicketDetail {
  ticket: Ticket;
  messages: TicketMessageRow[];
  user: { id: number; fullName: string | null; username: string | null } | null;
  customer: CustomerContext;
  timeline: { ticket: AuditLogRow[]; order: AuditLogRow[] };
}

interface AdminOption {
  id: number | null;
  telegramId: number;
  name: string | null;
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

// Same source/shape as SupportPage.tsx's useAdmins() — resolving an
// `adminId` (SupportTicket/AuditLog's FK) to a display name needs the same
// admin roster, and this is a super-admin-only route (requireSuper): a
// non-super admin simply sees the `Admin #<id>` fallback below, same as
// SupportPage's assignee Select does.
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

/** Up to `max` Telegram photo `file_id`s parsed from a CSV column — shared by
 * the ticket's own attachments and each thread message's. */
function parsePhotoIds(csv: string | null, max = 3): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

export function TicketDetailPage() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isError } = useTicket(ticketId ?? "");
  const { data: adminsData } = useAdmins();
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);

  const adminNameById = new Map<number, string>();
  for (const a of adminsData?.admins ?? []) {
    if (a.id !== null) adminNameById.set(a.id, a.name ?? `Telegram ID ${a.telegramId}`);
  }
  // I-1 (final whole-branch review): a CUSTOMER-actor row (e.g. the
  // ticket_create row every ticket now gets, or a customer's own
  // order_create/order_cancel/order_edit_info row) has adminId: null, same
  // as it does for a true system entry — so this used to fall straight
  // through to "System", mislabeling the customer's own action. The
  // customer's identity is already shown once at the top of this page
  // ("Customer: <name>"), so each timeline row just needs to say who acted,
  // not repeat which customer.
  function actorLabel(row: AuditLogRow): string {
    if (row.actorType === "CUSTOMER") return "Customer";
    if (row.adminId === null) return "System";
    return adminNameById.get(row.adminId) ?? `Admin #${row.adminId}`;
  }
  // Task 3 (Phase C): plain admin-id → display-name resolution for the
  // Assignment card's `ticket.adminId`/`ticket.assignedBy` fields — always a
  // genuine admin id (or null meaning "unset"), never a CUSTOMER actor, so
  // this doesn't need actorLabel's AuditLogRow-shaped CUSTOMER check above.
  // Reuses the same adminNameById lookup so both helpers stay in sync.
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

  // Task 3: assignment picker — wired to the same POST /api/support/:ticketId/assign
  // route SupportPage's own assignee Select posts to, now migrated (Task 3) to
  // call assignTicketWithAudit so both surfaces stamp assignedAt/assignedBy.
  const assign = useMutation({
    mutationFn: (nextAdminId: number | null) =>
      apiPost(`/api/support/${ticketId}/assign`, { adminId: nextAdminId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toast.success("Ticket assigned.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const close = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/close`, {}),
    onSuccess: () => {
      toast.success("Ticket closed.");
      navigate("/support");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const setPriority = useMutation({
    mutationFn: (priority: string) => apiPost(`/api/support/${ticketId}/priority`, { priority }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toast.success("Priority updated.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const setCategory = useMutation({
    mutationFn: (category: string | null) => apiPost(`/api/support/${ticketId}/classify`, { category }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toast.success("Category updated.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const resolve = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/resolve`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toast.success("Ticket marked resolved.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const reopen = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/reopen`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toast.success("Ticket reopened.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  if (isError) return <PageLayout title="Ticket"><p className="text-sm text-rust">Failed to load ticket.</p></PageLayout>;
  if (!data) return <PageLayout title="Ticket"><p>Loading…</p></PageLayout>;

  const { ticket, messages, user, customer, timeline } = data;

  // Chronological (oldest first): a synthetic "Created" row, then each audit
  // log in the order the actions actually happened — `timeline.ticket` comes
  // back newest-first from listAuditLogs, so it's reversed here.
  const ticketTimeline = [...timeline.ticket].reverse();

  const ticketPhotoIds = parsePhotoIds(ticket.photoFileIds);

  return (
    <PageLayout title={`Ticket ${ticketDisplayLabel(ticket)}`}>
      <PageHeader
        title={`Ticket ${ticketDisplayLabel(ticket)}`}
        description={ticket.message}
        breadcrumb={[{ label: "Support", href: "/support" }]}
        actions={
          <>
            <TicketStatusBadge status={ticket.status} />
            <Select
              value={ticket.priority}
              onValueChange={(v) => setPriority.mutate(v)}
              disabled={setPriority.isPending}
            >
              <SelectTrigger className="w-36" aria-label="Ticket priority">
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
              <SelectTrigger className="w-40" aria-label="Ticket category">
                <SelectValue>
                  {ticket.category ? categoryLabel(ticket.category) : "Uncategorized"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNCATEGORIZED}>Uncategorized</SelectItem>
                {CATEGORY_VALUES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {categoryLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Task 1 fix: mirrors the backend's actual resolveTicket guard (status
                NOT IN [RESOLVED, CLOSED]) instead of an OPEN/REPLIED whitelist —
                WAITING_ADMIN/WAITING_CUSTOMER tickets are now real and were
                silently losing this button under the old check. */}
            {ticket.status !== "RESOLVED" && ticket.status !== "CLOSED" && (
              <Button variant="outline" onClick={() => resolve.mutate()} disabled={resolve.isPending}>
                <CheckCircle2 className="h-4 w-4" />
                Resolve
              </Button>
            )}
            {ticket.status === "CLOSED" && (
              <Button variant="outline" onClick={() => reopen.mutate()} disabled={reopen.isPending}>
                <RotateCcw className="h-4 w-4" />
                Reopen
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 text-sm text-ink-soft">
        Customer: <span className="text-ink">{user?.fullName ?? user?.username ?? "Unknown"}</span>
      </div>

      <div className="grid grid-cols-1 gap-4 mb-6 lg:grid-cols-2">
        {/* Order context */}
        {ticket.order && (
          <Card>
            <CardHeader><CardTitle>Order Context</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-1 divide-y divide-line">
              <CardRow
                label="Order"
                value={
                  <Link to={`/orders/${ticket.order.id}`} className="font-mono text-xs text-pine hover:underline">
                    {ticket.order.orderCode}
                  </Link>
                }
              />
              <CardRow label="Purchased" value={<span className="text-xs text-ink-soft">{ticket.order.createdAtDisplay ?? "—"}</span>} />
              {ticket.order.voucher && (
                <CardRow
                  label="Voucher"
                  // break-all, not CardRow's generic break-words: a voucher
                  // code is one unbroken token, so break-words would leave it
                  // to be silently clipped by the card's overflow-hidden.
                  value={<span className="font-mono text-xs break-all">{ticket.order.voucher.code} ({ticket.order.voucher.type})</span>}
                />
              )}
            </CardContent>
            <CardContent className="flex flex-col gap-1">
              <div className="mb-1 text-xs font-medium text-ink-soft">Items</div>
              {ticket.order.items.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate text-ink" title={`${item.product.name} × ${item.quantity}`}>
                    {item.product.name} × {item.quantity}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-ink-soft">{item.unitPrice}</span>
                </div>
              ))}
            </CardContent>
            <CardContent className="border-t border-line pt-3 flex flex-col gap-2">
              <div className="text-xs font-medium text-ink-soft">Order Activity</div>
              {timeline.order.length === 0 ? (
                <p className="text-xs text-ink-soft">No order activity recorded.</p>
              ) : (
                timeline.order.map((row) => (
                  <div key={row.id} className="rounded-lg border-l-2 border-line bg-sand px-3 py-2">
                    <div className="mb-0.5 text-xs text-ink-soft">
                      {row.createdAtDisplay ?? "—"} — {actorLabel(row)}
                    </div>
                    <div className="text-sm break-words text-ink">{row.details ?? row.action}</div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        )}

        {/* Customer context */}
        <Card>
          <CardHeader><CardTitle>Customer</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-1 divide-y divide-line">
            <CardRow
              label="Total Spent"
              value={<CurrencyStack amounts={[{ currency: "IDR", value: customer.totalSpent.idr }, { currency: "USDT", value: customer.totalSpent.usdt }]} />}
            />
            <CardRow label="Total Orders" value={customer.orderCount} />
            <CardRow label="Open Tickets" value={customer.openTicketCount} />
          </CardContent>
          <CardContent>
            <Link to={`/users/${ticket.userId}`} className="text-sm text-pine hover:underline">
              View customer profile →
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Assignment — Task 3: surfaces assignedAt/assignedBy (Task 1)
          alongside the working-admin (adminId) picker. Posts to the same
          POST /api/support/:ticketId/assign route SupportPage's own
          per-row Select uses (Task 3 migrated that route to
          assignTicketWithAudit so both surfaces stamp the audit trail). */}
      <Card className="mb-6">
        <CardHeader><CardTitle>Assignment</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Select
            value={ticket.adminId !== null ? String(ticket.adminId) : UNASSIGNED}
            onValueChange={(v) => assign.mutate(v === UNASSIGNED ? null : Number(v))}
            disabled={assign.isPending}
          >
            <SelectTrigger className="w-56" aria-label="Ticket assignee">
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
          <span className="text-sm text-ink-soft">
            {ticket.assignedAt
              ? `Assigned by ${adminLabel(ticket.assignedBy)} on ${ticket.assignedAtDisplay ?? "—"}`
              : "Not yet assigned."}
          </span>
        </CardContent>
      </Card>

      {/* Ticket timeline */}
      <Card className="mb-6">
        <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div data-testid="timeline-row" className="rounded-lg border-l-2 border-pine bg-pine-tint px-4 py-3">
            <div className="mb-1 text-xs text-ink-soft">{ticket.createdAtDisplay ?? "—"}</div>
            <div className="text-sm text-ink">Created</div>
          </div>
          {ticketTimeline.map((row) => (
            <div key={row.id} data-testid="timeline-row" className="rounded-lg border-l-2 border-line bg-sand px-4 py-3">
              <div className="mb-1 text-xs text-ink-soft">
                {row.createdAtDisplay ?? "—"} — {actorLabel(row)}
              </div>
              <div className="text-sm break-words text-ink">{row.details ?? row.action}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Attachments on the original ticket submission */}
      {ticketPhotoIds.length > 0 && (
        <div className="mb-6 flex gap-2">
          {ticketPhotoIds.map((fileId) => (
            <button
              key={fileId}
              type="button"
              onClick={() => setPreviewFileId(fileId)}
              className="overflow-hidden rounded-lg border border-line"
              aria-label="View attachment"
            >
              <img src={`/api/support/photo/${fileId}`} alt="Attachment" className="h-16 w-16 object-cover" />
            </button>
          ))}
        </div>
      )}

      {/* Message thread */}
      <div className="flex flex-col gap-3 mb-6">
        {messages.map(m => {
          const messagePhotoIds = parsePhotoIds(m.photoFileIds);
          // Task 3: internal notes (Task 1's TicketMessage.internal) must be
          // visually distinct from customer-visible messages — dashed border,
          // no colored fill (unlike the solid pine/sand ADMIN/CUSTOMER tints
          // above, which both mean "the customer can see this"), plus an
          // explicit "Internal note" badge so it can't be mistaken for a real
          // reply at a glance.
          const isInternal = m.internal === true;
          return (
            <div
              key={m.id}
              data-testid="ticket-message"
              className={`rounded-lg border-l-2 px-4 py-3 ${
                isInternal
                  ? "border-dashed border-ink-faint bg-paper"
                  : m.senderType === "ADMIN"
                    ? "border-pine bg-pine-tint"
                    : "border-line bg-sand"
              }`}
            >
              <div className="mb-1 flex items-center gap-1.5 text-xs text-ink-soft">
                {isInternal && (
                  <Badge variant="secondary" className="gap-1">
                    <Lock className="h-3 w-3" />
                    Internal note
                  </Badge>
                )}
                <span>{m.senderType === "ADMIN" ? "Admin" : "Customer"} — {m.createdAtDisplay ?? "—"}</span>
              </div>
              {/* pre-wrap preserves long unbroken runs, so a pasted URL or
                  token overflows the bubble without break-words. */}
              <div className="text-sm text-ink whitespace-pre-wrap break-words">{m.content}</div>
              {messagePhotoIds.length > 0 && (
                <div className="mt-2 flex gap-2">
                  {messagePhotoIds.map((fileId) => (
                    <button
                      key={fileId}
                      type="button"
                      onClick={() => setPreviewFileId(fileId)}
                      className="overflow-hidden rounded-lg border border-line"
                      aria-label="View attachment"
                    >
                      <img src={`/api/support/photo/${fileId}`} alt="Attachment" className="h-16 w-16 object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Reply + close */}
      {ticket.status !== "CLOSED" && (
        <Card>
          <CardHeader><CardTitle>Reply</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            {replyError && <p className="text-sm text-rust">{replyError}</p>}
            <Textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              placeholder="Write a reply…"
              rows={4}
            />
            {/* Task 3: internal-note toggle. When checked, the reply is
                created with internal: true (Task 1's addTicketMessage) —
                stored, audited, and rendered in the timeline above as a
                dashed "Internal note" bubble instead of a customer-visible
                Admin reply; it never advances the ticket's status. */}
            <label className="flex items-center gap-2">
              <Checkbox
                checked={internal}
                onCheckedChange={(c) => setInternal(c === true)}
                aria-label="Internal note (not visible to the customer)"
              />
              <span className="text-sm text-ink">Internal note (not visible to the customer)</span>
            </label>
            <div className="flex gap-2">
              <Button onClick={() => sendReply.mutate()} disabled={!reply || sendReply.isPending}>
                {internal ? <Lock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                {sendReply.isPending ? "Saving…" : internal ? "Save Internal Note" : "Send Reply"}
              </Button>
              <ConfirmDialog
                trigger={<Button variant="destructive"><CircleX className="h-4 w-4" />Close Ticket</Button>}
                title="Close this ticket?"
                description="The ticket will be marked as closed and no further replies can be added."
                confirmLabel="Close"
                onConfirm={() => close.mutate()}
              />
            </div>
          </CardContent>
        </Card>
      )}

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
