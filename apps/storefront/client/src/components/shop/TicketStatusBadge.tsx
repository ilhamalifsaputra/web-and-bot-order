/** Ticket-specific status chip — friendlier copy + an icon than the generic
 * StatusBadge (which is shared across orders/stock/etc. and can't carry
 * ticket-specific wording without changing behavior everywhere else it's
 * used). Same visual language, composed on the `<Badge>` primitive
 * (`components/ui/Badge.tsx`) so the tint/tone pairing is the shared
 * `components.md` "Badge & chip" vocabulary rather than a hand-rolled class
 * list. The `business-adaptation.md` "Support-ticket states" table + this
 * file's own ticket-specific labels are preserved.
 *
 * Five buckets, not three: /help's status filter pills expose "waiting for
 * you" as its own filter carrying its own count (`SupportTicketStats
 * .waiting_for_you`), so if waiting_customer rendered the same chip as
 * replied, a buyer filtering to "Waiting for you" would see a list where
 * every row is labelled "In progress". `attention` (plum) exists for exactly
 * that bucket — see components/ui/Badge.tsx and tokens.extensions.css. */
import { Clock, MessageCircle, CheckCircle2, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";
import Badge, { type BadgeVariant } from "../ui/Badge";

// Five buckets, one per meaning a buyer needs to tell apart on the /help
// ticket list. waiting_admin/waiting_customer are the real live values a
// ticket's status takes after its first reply (Task 1's automatic
// transition); open+waiting_admin still read as one thing to a buyer
// ("still with support"), but replied ("we're working on it") and
// waiting_customer ("your move") no longer share a label/tone, and
// resolved gets its own copy distinct from a hard closed.
const LABEL_KEY: Record<string, string> = {
  open: "web.ticket_status_open",
  waiting_admin: "web.ticket_status_open",
  replied: "web.ticket_status_in_progress",
  waiting_customer: "web.ticket_status_waiting_you",
  resolved: "web.ticket_status_resolved",
  closed: "web.ticket_status_closed",
};
const ICON: Record<string, LucideIcon> = {
  open: Clock,
  waiting_admin: Clock,
  replied: MessageCircle,
  waiting_customer: MessageCircle,
  resolved: CheckCircle2,
  closed: CheckCircle2,
};
// Tone polarity: amberx = "waiting on support", pine = "actively in
// progress", plum = "your move". The pre-/help version mapped open→info and
// replied→pending, which read correctly only while waiting_customer was
// folded into replied — once "your move" is its own bucket, amber has to mean
// waiting and blue has to mean moving, or the list tells the buyer the
// opposite of what the filter pills do.
const VARIANT: Record<string, BadgeVariant> = {
  open: "pending",
  waiting_admin: "pending",
  replied: "info",
  waiting_customer: "attention",
  resolved: "success",
  closed: "neutral",
};

export default function TicketStatusBadge({ value }: { value: string }) {
  const v = String(value).toLowerCase();
  const Icon = ICON[v] ?? Clock;
  const variant = VARIANT[v] ?? "neutral";
  const label = LABEL_KEY[v] ? t(LABEL_KEY[v]!) : value;
  return (
    // whitespace-nowrap: live /help testing showed the two-word labels
    // ("Waiting for Support", "Waiting for You") wrapping inside the STATUS
    // table cell, which made the pills different heights down the column.
    // `.chip` sets no white-space of its own, so this stays explicit.
    <Badge variant={variant} className="whitespace-nowrap" icon={<Icon className="w-3.5 h-3.5" />}>
      {label}
    </Badge>
  );
}
