/** Ticket-specific status chip — friendlier copy + an icon than the generic
 * StatusBadge (which is shared across orders/stock/etc. and can't carry
 * ticket-specific wording without changing behavior everywhere else it's
 * used). Same visual language (the shared `chip` class + tone colors). */
import { Clock, MessageCircle, CheckCircle2, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";

const LABEL_KEY: Record<string, string> = {
  open: "web.ticket_status_open",
  replied: "web.ticket_status_replied",
  closed: "web.ticket_status_closed",
};
const ICON: Record<string, LucideIcon> = {
  open: Clock,
  replied: MessageCircle,
  closed: CheckCircle2,
};
const TONE: Record<string, string> = {
  open: "bg-pine-tint text-pine-dark",
  replied: "bg-amberx-tint text-amberx",
  closed: "bg-grass-tint text-grass-dark",
};

export default function TicketStatusBadge({ value }: { value: string }) {
  const v = String(value).toLowerCase();
  const Icon = ICON[v] ?? Clock;
  const tone = TONE[v] ?? "bg-sand text-ink-soft";
  const label = LABEL_KEY[v] ? t(LABEL_KEY[v]!) : value;
  return (
    <span className={`chip inline-flex items-center gap-1 ${tone}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </span>
  );
}
