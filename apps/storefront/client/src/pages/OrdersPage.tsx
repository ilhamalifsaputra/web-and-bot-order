/**
 * TSX port of apps/storefront/views/orders.njk. Markup/classes copied
 * verbatim apart from the mechanical Tailwind v3→v4 renames
 * (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { AccountOrdersData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import Price from "../components/shop/Price";
import StatusBadge from "../components/shop/StatusBadge";

export default function OrdersPage() {
  const { data: ctx } = useShopContext();
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

  if (!data) return null;

  return (
    <>
      <h1 className="page-title mb-6">{t("web.account_orders")}</h1>

      <div className="card overflow-x-auto">
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
            {data.orders.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-ink-faint">
                  {t("web.no_orders")}
                </td>
              </tr>
            ) : (
              data.orders.map((o) => (
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
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
