import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { apiGet, apiPost } from "../api/client";
import { CursorPagination } from "../components/shared/CursorPagination";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { FilterBar } from "../components/shared/FilterBar";
import { PageHeader } from "../components/shared/PageHeader";
import { PageLayout } from "../components/shared/PageLayout";
import { StatusBadge } from "../components/shared/StatusBadge";
import { statusLabel } from "../components/shared/StatusBadge.helpers";
import { describeError } from "../lib/errorMessages";

/** NotificationEvent values from packages/core/src/enums.ts, labeled
 * explicitly here (pre-existing Telegram events plus the 4 EMAIL-channel
 * owner-notification events added alongside owner email notifications).
 * Mirrors AuditPage.tsx's ACTION_LABELS pattern: unknown/future values
 * (including any pre-existing event not yet added here) fall back to
 * humanizeEventCode() instead of showing the raw enum — still readable,
 * just not an explicit label. The "Owner email: ..." / "Buyer email: ..."
 * prefixes keep the EMAIL-channel events visually distinguishable from the
 * Telegram-oriented labels at a glance — and, between themselves, make the
 * recipient obvious, since those two go to very different people. */
const EVENT_LABELS: Record<string, string> = {
  ORDER_DELIVERED: "Order delivered",
  ADMIN_OVERPAID: "Admin overpaid alert",
  ADMIN_PW_RESET: "Admin password reset",
  ORDER_DELIVERED_DM: "Order delivered (DM)",
  ORDER_PROCESSING_DM: "Order processing (DM)",
  ORDER_MANUAL_DELIVERED_DM: "Manual order delivered (DM)",
  ORDER_PIPELINE_FAILED: "Order pipeline failed",
  PRODUCT_RESTOCKED_BROADCAST: "Product restocked broadcast",
  RESTOCK_SUBSCRIBER_NOTIFIED: "Restock request notified",
  FLASH_SALE_BROADCAST: "Flash sale broadcast",
  ADMIN_MANUAL_ORDER_QUEUED: "Manual order queued",
  BULK_PURCHASE_BROADCAST: "Bulk purchase broadcast",
  ADMIN_STALE_PAYMENT: "Admin stale payment alert",
  OWNER_EMAIL_ORDER_PAID: "Owner email: order paid",
  OWNER_EMAIL_MANUAL_ORDER_QUEUED: "Owner email: manual order queued",
  OWNER_EMAIL_NEW_TICKET: "Owner email: new ticket",
  OWNER_EMAIL_TICKET_REPLY: "Owner email: ticket reply",
  OWNER_EMAIL_WALLET_TOPUP: "Owner email: wallet top-up",
  // "Buyer email", not "Owner email" — this is the only EMAIL-channel event
  // that goes to the customer rather than to the shop owner, and the label
  // has to make that obvious at a glance in this table.
  BUYER_EMAIL_ORDER_READY: "Buyer email: order ready",
};

function humanizeEventCode(event: string): string {
  return event
    .split(/[_.]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? humanizeEventCode(event);
}

/** Two-value transport badge (TELEGRAM | EMAIL, see NotificationOutbox.channel).
 * Deliberately a plain inline span rather than an extension of `StatusBadge` —
 * that component's TONE map is keyed by status vocabulary (SENT/FAILED/...),
 * and folding an unrelated two-value dimension into it would blur what each
 * color means there. Follows the same pill styling as `StatusBadge` and
 * `PaymentMethodBadge`: EMAIL gets the `pine` accent (unused by StatusBadge's
 * success/warning/danger palette, so it reads as a distinct "channel" cue
 * rather than a status), TELEGRAM stays the neutral `sand` tone since it's
 * the long-standing default transport. */
function ChannelBadge({ channel }: { channel: string }) {
  const isEmail = channel === "EMAIL";
  const cls = isEmail ? "bg-pine-tint text-pine-dark" : "bg-sand text-ink-soft";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {isEmail ? "Email" : "Telegram"}
    </span>
  );
}

interface OutboxRow {
  id: number;
  event: string;
  orderId: number | null;
  channel: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  createdAtDisplay: string | null;
  sentAt: string | null;
  sentAtDisplay: string | null;
  emailAcceptedAt?: string | null;
  emailRecipientMasked?: string | null;
  emailErrorCode?: string | null;
}

const EMAIL_ERROR_GUIDANCE: Record<string, string> = {
  SMTP_AUTH: "SMTP authentication failed. Check the saved credentials.",
  SMTP_RECIPIENT: "The mail server rejected the recipient. Check the saved email address.",
  SMTP_TLS: "SMTP certificate verification failed. Check the server settings.",
  SMTP_REJECTED: "The mail server rejected the message. Review the provider diagnostics.",
  SMTP_TEMPORARY: "The mail server temporarily rejected the message. Review the attempt count before retrying.",
  SMTP_CONNECTION: "The mail server could not be reached. Check the connection and settings.",
  SMTP_ACCEPTANCE_UNCONFIRMED: "The transport returned no valid acceptance evidence. Delivery is unconfirmed.",
  SMTP_NOT_CONFIGURED: "Configure SMTP before retrying delivery.",
  SMTP_SETTINGS_UNAVAILABLE: "SMTP settings could not be read. Check the configuration.",
  EMAIL_POLICY_UNAVAILABLE: "Email preferences could not be read. Check the configuration before retrying.",
  EMAIL_RENDER_FAILED: "The email template could not be rendered. Review application diagnostics.",
  SKIPPED_DISABLED: "The event was disabled before delivery.",
  SKIPPED_NO_RECIPIENT: "No valid recipient email was available.",
  NO_RECIPIENT: "No valid recipient email was available.",
};

function OutboxDeliveryStatus({ row }: { row: OutboxRow }) {
  if (row.channel !== "EMAIL") return <StatusBadge status={row.status} />;
  if (row.status === "SENT") return <span className={`text-xs font-medium ${row.emailAcceptedAt ? "text-grass-dark" : "text-ink-soft"}`}>{row.emailAcceptedAt ? "Accepted by mail server" : "Sent (acceptance unverified)"}</span>;
  const reason = row.emailErrorCode ?? row.lastError;
  if (reason === "SKIPPED_DISABLED") return <span className="text-xs text-ink-soft">Skipped: disabled</span>;
  if (reason === "NO_RECIPIENT" || reason === "SKIPPED_NO_RECIPIENT") return <span className="text-xs text-ink-soft">Skipped: no recipient</span>;
  return <StatusBadge status={row.status} />;
}

interface OutboxResponse {
  rows: OutboxRow[];
  total: number;
  page: number;
  hasNext: boolean;
  counts: Record<string, number>;
}

export function OutboxPage() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [applied, setApplied] = useState({ status: "", page: 1 });
  const [retrying, setRetrying] = useState<Set<number>>(new Set());

  const { data, isLoading, isError, refetch } = useQuery<OutboxResponse>({
    queryKey: ["outbox", applied],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (applied.status) p.set("status", applied.status);
      if (applied.page > 1) p.set("page", String(applied.page));
      return apiGet<OutboxResponse>(`/api/outbox?${p}`);
    },
  });

  async function retry(id: number) {
    setRetrying((s) => new Set([...s, id]));
    try {
      await apiPost(`/api/outbox/${id}/retry`, {});
      await refetch();
      toast.success("Notification retried.");
    } catch (e: unknown) {
      toast.error(describeError((e instanceof Error ? e.message : String(e)) || "Failed to retry notification"));
    } finally {
      setRetrying((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  function apply() {
    setPage(1);
    setApplied({ status, page: 1 });
  }

  function goPage(n: number) {
    setPage(n);
    setApplied((a) => ({ ...a, page: n }));
  }

  return (
    <PageLayout title="Outbox">
      <PageHeader title="Outbox" />

      <div className="flex flex-col gap-4">
        {data?.counts && (
          <div className="flex gap-3">
            {Object.entries(data.counts).map(([k, v]) => (
              <span key={k} className="rounded-full bg-sand px-3 py-1 text-xs font-medium text-ink">
                {k}: {v}
              </span>
            ))}
          </div>
        )}

        <FilterBar onApply={apply}>
          <Select value={status || "_all_"} onValueChange={v => setStatus(v === "_all_" ? "" : v)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All statuses</SelectItem>
              {["PENDING", "SENDING", "SENT", "FAILED", "DEAD_LETTER"].map((s) => (
                <SelectItem key={s} value={s}>{statusLabel(s)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterBar>

        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Failed to load outbox.</p>}

        {data && (
          <Card>
            <CardContent>
              <DataTable
                nested
                columns={[
                  { key: "id", header: "ID", render: (row) => <span className="block max-w-[200px] truncate font-mono text-xs text-ink-soft" title={String(row.id)}>{row.id}</span> },
                  { key: "event", header: "Event", render: (row) => <span className="text-ink" title={row.event}>{eventLabel(row.event)}</span> },
                  { key: "channel", header: "Channel", render: (row) => <ChannelBadge channel={row.channel} /> },
                  { key: "status", header: "Status", render: (row) => <OutboxDeliveryStatus row={row} /> },
                  { key: "recipient", header: "Recipient", render: (row) => <span className="text-xs text-ink-soft">{row.emailRecipientMasked ?? "—"}</span> },
                  { key: "emailError", header: "Email diagnostics", render: (row) => <span className="text-xs text-ink-soft">{row.channel === "EMAIL" && row.emailErrorCode ? EMAIL_ERROR_GUIDANCE[row.emailErrorCode] ?? "Delivery could not be completed. Review the application diagnostics." : "—"}</span> },
                  { key: "attempts", header: "Attempts", render: (row) => <span className="text-ink-soft">{row.attempts}</span> },
                  { key: "created", header: "Created", render: (row) => <span className="whitespace-nowrap text-ink-soft">{row.createdAtDisplay ?? "—"}</span> },
                  { key: "sent", header: "Sent", render: (row) => <span className="whitespace-nowrap text-ink-soft">{row.sentAtDisplay ?? "—"}</span> },
                  {
                    key: "actions",
                    header: "",
                    render: (row) =>
                      ["FAILED", "DEAD_LETTER"].includes(row.status) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={retrying.has(row.id)}
                          onClick={() => retry(row.id)}
                        >
                          <RefreshCw className="h-4 w-4" />
                          Retry
                        </Button>
                      ) : null,
                  },
                ]}
                data={data.rows}
                keyExtractor={(row) => row.id}
                empty={
                  <EmptyState
                    icon={Send}
                    title="No notifications found."
                    description="Outbound notifications will appear here."
                  />
                }
              />
            </CardContent>
          </Card>
        )}

        {data && (data.hasNext || page > 1) && (
          <CursorPagination page={page} hasNext={data.hasNext} onPageChange={goPage} />
        )}
      </div>
    </PageLayout>
  );
}
