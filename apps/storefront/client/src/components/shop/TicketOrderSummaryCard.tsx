/** The linked order's context card in the ticket sidebar. "Download
 * Credentials"/"View order" both deep-link to OrderDetailPage rather than
 * re-rendering the credential-reveal UI here — that page's existing
 * reveal/copy block stays the single source of truth for showing a secret
 * (see Task 13's `id="credentials"` anchor + scroll effect). Uses a native
 * `<details open>` rather than a plain `<section>` so it collapses into an
 * expandable section on narrow viewports (design spec: "sidebar collapses
 * into expandable sections" on tablet/mobile) without a dedicated accordion
 * component — `open` by default keeps desktop looking exactly like a normal
 * always-expanded card. */
import { Copy, ExternalLink, ShieldCheck, ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { t } from "../../lib/i18n";
import { formatIdr } from "../../lib/format";
import type { TicketOrderSummary } from "../../api/types";
import StatusBadge from "./StatusBadge";

export default function TicketOrderSummaryCard({ order }: { order: TicketOrderSummary }) {
  const orderHref = `/account/orders/${order.code}${order.delivered ? "#credentials" : ""}`;
  return (
    <details open className="card card-pad">
      <summary className="section-title cursor-pointer">{t("web.ticket_order_summary_title")}</summary>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="font-mono text-sm">{order.code}</span>
        <StatusBadge value={order.status} />
      </div>
      <dl className="mt-3 space-y-1.5 text-sm">
        {order.items.map((item, idx) => (
          <div key={idx} className="flex justify-between gap-3">
            <dt className="text-ink-soft">
              {item.name}
              {item.duration ? ` · ${item.duration}` : ""}
            </dt>
            <dd className="text-right text-xs">
              {item.warranty_active ? (
                <span className="inline-flex items-center gap-1 text-grass-dark">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  {t("web.ticket_warranty_until", { date: item.warranty_expires_at_display ?? "" })}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-ink-faint">
                  <ShieldAlert className="w-3.5 h-3.5" /> {t("web.ticket_warranty_expired")}
                </span>
              )}
            </dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-line pt-1.5">
          <dt className="text-ink-soft">{t("web.order_date")}</dt>
          <dd>{order.created_at_display}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-soft">{t("web.ticket_payment_method")}</dt>
          <dd>{order.payment_method}</dd>
        </div>
        {order.voucher_code && (
          <div className="flex justify-between gap-3">
            <dt className="text-ink-soft">{t("web.ticket_voucher_used")}</dt>
            <dd className="font-mono">{order.voucher_code}</dd>
          </div>
        )}
        <div className="flex justify-between gap-3 border-t border-line pt-1.5 font-semibold">
          <dt>{t("web.order_total")}</dt>
          <dd>{formatIdr(order.total)}</dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to={orderHref} className="btn btn-soft btn-sm">
          <ExternalLink className="w-3.5 h-3.5" />
          {order.delivered ? t("web.ticket_download_credentials") : t("web.ticket_view_order")}
        </Link>
        <button type="button" className="btn btn-soft btn-sm" onClick={() => navigator.clipboard.writeText(order.code)}>
          <Copy className="w-3.5 h-3.5" /> {t("web.ticket_copy_order_code")}
        </button>
      </div>
    </details>
  );
}
