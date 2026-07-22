/**
 * Order history. Originally a 1:1 port of apps/storefront/views/orders.njk —
 * a five-column table wrapped in `overflow-x-auto`, which on a phone meant the
 * columns were both unreadable and behind a sideways scroll. The same rows now
 * render as cards below `md` and as the table from `md` up, one or the other,
 * never both (see lib/useMediaQuery.ts).
 */
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { apiGet } from "../api/client";
import type { AccountOrderSummary, AccountOrdersData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { useIsDesktop } from "../lib/useMediaQuery";
import EmptyState from "../components/shop/EmptyState";
import Price from "../components/shop/Price";
import Skeleton from "../components/shop/Skeleton";
import StatusBadge from "../components/shop/StatusBadge";

const SKELETON_ROWS = Array.from({ length: 4 }, (_, i) => i);

/** One order as a card — the whole card is the tap target. */
function OrderCard({ order, fx }: { order: AccountOrderSummary; fx: string | null | undefined }) {
  return (
    <Link
      to={`/account/orders/${order.code}`}
      // Without this the link's accessible name would be the card's entire
      // text run; the code alone is what identifies the order.
      aria-label={order.code}
      className="card block p-4 transition-colors hover:bg-sand/40"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs font-semibold text-pine">{order.code}</span>
        <StatusBadge value={order.status} />
      </div>
      <p className="mt-2 line-clamp-2 text-sm text-ink">{order.items}</p>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
        <Price value={order.total} fx={fx} size="text-sm" />
        <span className="text-xs text-ink-soft">{order.created_at_display}</span>
      </div>
    </Link>
  );
}

export default function OrdersPage() {
  const { data: ctx } = useShopContext();
  const isDesktop = useIsDesktop();
  const { data, error } = useQuery({
    queryKey: ["account-orders"],
    queryFn: () => apiGet<AccountOrdersData>("/api/v1/account/orders"),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent("/account/orders"));
    }
  }, [error]);

  // A placeholder shaped like the loaded page, rather than the blank screen
  // this rendered while the query was in flight.
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <Skeleton className="mb-6 h-8 w-48" />
        <div className="space-y-3">
          {SKELETON_ROWS.map((i) => (
            <div key={i} className="card space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-20" />
              </div>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-32" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <h1 className="page-title mb-6">{t("web.account_orders")}</h1>

      {data.orders.length === 0 ? (
        /* STO-016: a bare empty-state sentence with no forward action stranded
           first-time visitors here — it now names the next step. */
        <EmptyState
          icon={Receipt}
          title={t("web.no_orders")}
          description={t("web.no_orders_desc")}
          action={{ label: t("web.nav_products"), to: "/products" }}
          secondaryAction={{ label: t("web.continue_shopping"), to: "/" }}
        />
      ) : isDesktop ? (
        /* Desktop keeps the table: the columns fit, and comparing many orders
           at a glance is easier in a grid than in a stack of cards. */
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("web.order_code")}</th>
                <th>{t("web.order_items")}</th>
                <th>{t("web.order_total")}</th>
                <th>{t("web.order_status")}</th>
                <th>{t("web.order_date")}</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.code}>
                  <td>
                    <Link to={`/account/orders/${o.code}`} className="link font-mono text-xs">
                      {o.code}
                    </Link>
                  </td>
                  <td className="max-w-[16rem] truncate">{o.items}</td>
                  <td>
                    <Price value={o.total} fx={ctx?.fx} size="text-sm" />
                  </td>
                  <td>
                    <StatusBadge value={o.status} />
                  </td>
                  <td className="text-ink-soft text-xs">{o.created_at_display}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="space-y-3">
          {data.orders.map((o) => (
            <li key={o.code}>
              <OrderCard order={o} fx={ctx?.fx} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
