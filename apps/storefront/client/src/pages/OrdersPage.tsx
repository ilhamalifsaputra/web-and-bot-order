/**
 * Order history. Originally a 1:1 port of apps/storefront/views/orders.njk —
 * a five-column table wrapped in `overflow-x-auto`, which on a phone meant the
 * columns were both unreadable and behind a sideways scroll. The same rows now
 * render as cards below `md` and as the table from `md` up, one or the other,
 * never both (see lib/useMediaQuery.ts).
 *
 * Task 16 (design-system migration, page-templates.md §6): heading + a filter
 * row (search `Input` + status `Select`), shown only once there is more than
 * one order to filter (SortSelect's "products.length > 1" precedent). Filtering
 * is entirely client-side — the endpoint still returns the full list and no
 * query param is sent. The empty state now distinguishes "no orders yet" (a
 * first-time visitor — keep the suggestions shelf + catalogue CTA) from "no
 * orders match this filter" (§16 — a dead end otherwise, so it names a way
 * out).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { apiGet } from "../api/client";
import type { AccountOrderSummary, AccountOrdersData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { useIsDesktop } from "../lib/useMediaQuery";
import { useSuggestedProducts } from "../lib/useSuggestedProducts";
import EmptyState from "../components/shop/EmptyState";
import { formatOrderAmount } from "../lib/format";
import Skeleton from "../components/shop/Skeleton";
import StatusBadge, { statusLabel } from "../components/shop/StatusBadge";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";

const SKELETON_ROWS = Array.from({ length: 4 }, (_, i) => i);

/** An order's settled total, in the order's OWN currency — never through
 * <Price/>, whose display-currency conversion would double-convert it (a
 * 9.88 USDT order re-read as Rp9.88 and shown as "$0.01"). Task 5 fix pass. */
function OrderTotal({ order }: { order: AccountOrderSummary }) {
  return (
    <span className="font-semibold text-pine text-sm whitespace-nowrap">
      {formatOrderAmount(order.total, order.currency)}
    </span>
  );
}

/** One order as a card — the whole card is the tap target. */
function OrderCard({ order }: { order: AccountOrderSummary }) {
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
        <OrderTotal order={order} />
        <span className="text-xs text-ink-soft">{order.created_at_display}</span>
      </div>
    </Link>
  );
}

export default function OrdersPage() {
  const { data: ctx } = useShopContext();
  const isDesktop = useIsDesktop();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const { data, error } = useQuery({
    queryKey: ["account-orders"],
    queryFn: () => apiGet<AccountOrdersData>("/api/v1/account/orders"),
    retry: false,
  });
  // Fetched only once it's known there are no orders — never delays the
  // empty-state card itself, which paints from `data` alone.
  const { data: suggested } = useSuggestedProducts(!!data && data.orders.length === 0);

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

  const hasOrders = data.orders.length > 0;
  // A filter over a single order sorts nothing — mirror SortSelect's
  // "only when there's more than one" gate.
  const showFilters = data.orders.length > 1;
  const statuses = [...new Set(data.orders.map((o) => o.status))];
  const q = search.trim().toLowerCase();
  const orders = data.orders.filter((o) => {
    const matchesText = !q || o.code.toLowerCase().includes(q) || o.items.toLowerCase().includes(q);
    const matchesStatus = statusFilter === "all" || o.status === statusFilter;
    return matchesText && matchesStatus;
  });

  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
  }

  return (
    <>
      <h1 className="page-title mb-6">{t("web.account_orders")}</h1>

      {showFilters && (
        <div className="mb-6 flex flex-col gap-3 sm:flex-row">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("web.orders_filter_search")}
            aria-label={t("web.orders_filter_search")}
            className="sm:flex-1"
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label={t("web.order_status")}
            className="sm:w-56"
          >
            <option value="all">{t("web.orders_filter_all_status")}</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
      )}

      {!hasOrders ? (
        /* STO-016: a bare empty-state sentence with no forward action stranded
           first-time visitors here — it now names the next step. */
        <EmptyState
          icon={Receipt}
          title={t("web.no_orders")}
          description={t("web.no_orders_desc")}
          action={{ label: t("web.nav_products"), to: "/products" }}
          secondaryAction={{ label: t("web.continue_shopping"), to: "/" }}
          suggestions={suggested ? { products: suggested.products, fx: ctx?.fx, lowThreshold: suggested.low_threshold } : undefined}
        />
      ) : orders.length === 0 ? (
        /* §16: a filter that matches nothing is a dead end unless it offers a
           way back. Distinct copy from "no orders yet" so the two states never
           read the same. */
        <>
          <EmptyState
            icon={Receipt}
            title={t("web.orders_no_match")}
            description={t("web.orders_no_match_desc")}
          />
          <div className="mt-2 text-center">
            <Button variant="soft" onClick={clearFilters}>
              {t("web.orders_filter_clear")}
            </Button>
          </div>
        </>
      ) : isDesktop ? (
        /* Desktop keeps the table: the columns fit, and comparing many orders
           at a glance is easier in a grid than in a stack of cards. */
        <Card padded={false}>
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
              {orders.map((o) => (
                <tr key={o.code}>
                  <td>
                    <Link to={`/account/orders/${o.code}`} className="link font-mono text-xs">
                      {o.code}
                    </Link>
                  </td>
                  <td className="max-w-[16rem] truncate">{o.items}</td>
                  <td>
                    <OrderTotal order={o} />
                  </td>
                  <td>
                    <StatusBadge value={o.status} />
                  </td>
                  <td className="text-ink-soft text-xs">{o.created_at_display}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.code}>
              <OrderCard order={o} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
