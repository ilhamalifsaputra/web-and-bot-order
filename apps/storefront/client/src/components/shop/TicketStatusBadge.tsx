/** Ticket-specific status chip — friendlier copy + an icon than the generic
 * StatusBadge (which is shared across orders/stock/etc. and can't carry
 * ticket-specific wording without changing behavior everywhere else it's
 * used). Same visual language, now composed on the `<Badge>` primitive
 * (`components/ui/Badge.tsx`) so the tint/tone pairing is the shared
 * `components.md` "Badge & chip" vocabulary rather than a hand-rolled class
 * list: OPEN → `info` (pine chip), REPLIED → `pending` (amberx chip),
 * CLOSED → `success` (grass chip), unknown → `neutral` (sand chip). The
 * `business-adaptation.md` "Support-ticket states" table + this file's own
 * ticket-specific labels are preserved. */
import { Clock, MessageCircle, CheckCircle2, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";
import Badge, { type BadgeVariant } from "../ui/Badge";

// Phase C whole-branch review fix: waiting_admin/waiting_customer are the
// real live values a ticket's status now takes after its first reply (Task
// 1's automatic transition) — bucketed under open/replied's existing
// copy+tone since that's what they mean to a buyer reading this page
// ("we're on it" / "we replied, your turn"), not a new distinct meaning.
const LABEL_KEY: Record<string, string> = {
  open: "web.ticket_status_open",
  waiting_admin: "web.ticket_status_open",
  replied: "web.ticket_status_replied",
  waiting_customer: "web.ticket_status_replied",
  closed: "web.ticket_status_closed",
};
const ICON: Record<string, LucideIcon> = {
  open: Clock,
  waiting_admin: Clock,
  replied: MessageCircle,
  waiting_customer: MessageCircle,
  closed: CheckCircle2,
};
const VARIANT: Record<string, BadgeVariant> = {
  open: "info",
  waiting_admin: "info",
  replied: "pending",
  waiting_customer: "pending",
  closed: "success",
};

export default function TicketStatusBadge({ value }: { value: string }) {
  const v = String(value).toLowerCase();
  const Icon = ICON[v] ?? Clock;
  const variant = VARIANT[v] ?? "neutral";
  const label = LABEL_KEY[v] ? t(LABEL_KEY[v]!) : value;
  return (
    <Badge variant={variant} icon={<Icon className="w-3.5 h-3.5" />}>
      {label}
    </Badge>
  );
}
