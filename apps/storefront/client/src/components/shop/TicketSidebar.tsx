/** Composes the ticket detail page's right column: linked-order summary (or
 * a generic fallback), trust badges, recent tickets, and help links. Every
 * section is a native `<details open>` (see TicketOrderSummaryCard's header
 * comment) so the whole sidebar reads as a stack of expandable sections on
 * narrow viewports, without a dedicated accordion component. The page's own
 * grid handles the desktop 70/30 split and collapses to a single column
 * below `lg` — this component doesn't need its own breakpoint logic. */
import { Link } from "react-router-dom";
import { LifeBuoy, Mail, ShieldCheck, Lock, Zap, BadgeCheck } from "lucide-react";
import { t } from "../../lib/i18n";
import TicketOrderSummaryCard from "./TicketOrderSummaryCard";
import TicketStatusBadge from "./TicketStatusBadge";
import type { SupportTicketSummary, TicketOrderSummary } from "../../api/types";

export interface TicketSidebarProps {
  order: TicketOrderSummary | null;
  recentTickets: SupportTicketSummary[];
  currentTicketId: number;
  telegramSupportUrl: string | null;
}

export default function TicketSidebar({ order, recentTickets, currentTicketId, telegramSupportUrl }: TicketSidebarProps) {
  const others = recentTickets.filter((tk) => tk.id !== currentTicketId).slice(0, 5);
  return (
    <aside className="space-y-4">
      {order ? (
        <TicketOrderSummaryCard order={order} />
      ) : (
        <details open className="card card-pad text-sm text-ink-soft">
          <summary className="section-title cursor-pointer">{t("web.ticket_order_summary_title")}</summary>
          <p className="mt-2">{t("web.ticket_no_order_linked")}</p>
        </details>
      )}

      {order && (
        <details open className="card card-pad">
          <summary className="section-title cursor-pointer">{t("web.ticket_trust_title")}</summary>
          <ul className="mt-2 space-y-2 text-xs text-ink-soft">
            <li className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-grass" /> {t("web.ticket_trust_warranty")}
            </li>
            <li className="flex items-center gap-2">
              <BadgeCheck className="w-4 h-4 text-grass" /> {t("web.ticket_trust_verified")}
            </li>
            <li className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-grass" /> {t("web.ticket_trust_delivery")}
            </li>
            <li className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-grass" /> {t("web.ticket_trust_encrypted")}
            </li>
          </ul>
        </details>
      )}

      {others.length > 0 && (
        <details open className="card card-pad">
          <summary className="section-title cursor-pointer">{t("web.ticket_recent_title")}</summary>
          <ul className="mt-2 divide-y divide-line">
            {others.map((tk) => (
              <li key={tk.id} className="py-2 first:pt-0 last:pb-0">
                <Link to={`/account/support/${tk.id}`} className="flex items-center justify-between gap-2 text-sm hover:text-pine">
                  <span>#{tk.id}</span>
                  <TicketStatusBadge value={tk.status} />
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}

      <details open className="card card-pad">
        <summary className="section-title cursor-pointer flex items-center gap-2">
          <LifeBuoy className="w-4 h-4" /> {t("web.ticket_help_title")}
        </summary>
        <ul className="mt-2 space-y-2 text-sm">
          {telegramSupportUrl && (
            <li>
              <a href={telegramSupportUrl} target="_blank" rel="noreferrer" className="link">
                {t("web.ticket_help_telegram")}
              </a>
            </li>
          )}
          <li className="flex items-center gap-2 text-ink-soft">
            <Mail className="w-4 h-4" /> {t("web.ticket_help_email_hint")}
          </li>
          <li>
            <Link to="/account/support" className="link">
              {t("web.ticket_new_ticket_link")}
            </Link>
          </li>
        </ul>
      </details>
    </aside>
  );
}
