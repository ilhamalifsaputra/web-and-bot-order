/**
 * TSX port of apps/storefront/views/order_detail.njk. "Subtotal"/"Bulk"/
 * "Voucher" are literal English in the NJK (no `t()` call there — not every
 * label on this template is localized), ported as literal text rather than
 * i18n keys to stay 1:1. Copy-to-clipboard for a credential reads straight
 * from the item's own value instead of round-tripping through the DOM (the
 * NJK used `getElementById` only because it had no other handle on the
 * string). Markup/classes copied verbatim apart from the mechanical
 * Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md): `!text-2xl`
 * → `text-2xl!`, `!text-sm` → `text-sm!`.
 */
import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, Copy, Wallet } from "lucide-react";
import { apiGet } from "../api/client";
import type { OrderDetailData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { formatIdr } from "../lib/format";
import Price from "../components/shop/Price";
import StatusBadge from "../components/shop/StatusBadge";
import ErrorPage from "./ErrorPage";

export default function OrderDetailPage() {
  const { code = "" } = useParams<{ code: string }>();
  const { data: ctx } = useShopContext();
  const { data, error } = useQuery({
    queryKey: ["account-order", code],
    queryFn: () => apiGet<OrderDetailData>(`/api/v1/account/orders/${code}`),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent(`/account/orders/${code}`));
    }
  }, [error, code]);

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    return null;
  }
  if (!data) return null;

  const { order, delivered, pending_payment: pendingPayment } = data;
  const showBulk = Boolean(order.bulk_discount) && order.bulk_discount !== "0";
  const showVoucher = Boolean(order.discount) && order.discount !== "0";

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs text-ink-faint mb-1">
            <Link to="/account/orders" className="hover:text-pine">
              {t("web.account_orders")}
            </Link>
            <span className="mx-1">/</span> <span className="font-mono">{order.code}</span>
          </div>
          <h1 className="page-title text-2xl!">
            {t("web.order_code")} <span className="font-mono">{order.code}</span>
          </h1>
        </div>
        <StatusBadge value={order.status} />
      </div>

      {pendingPayment && (
        <div className="card card-pad mb-5 flex items-center justify-between gap-3 flex-wrap bg-pine-tint/40">
          <div className="text-sm text-ink-soft">
            {t("web.order_status")}: <StatusBadge value={order.status} />
          </div>
          <Link to={`/checkout/${order.code}/pay`} className="btn btn-primary">
            <Wallet className="w-4 h-4" /> {t("web.pay_now")}
          </Link>
        </div>
      )}

      <div className="card overflow-x-auto mb-5">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("web.order_items")}</th>
              <th>{t("web.order_total")}</th>
              <th>{t("web.warranty")}</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((i, idx) => (
              <tr key={idx}>
                <td>
                  <div className="font-semibold text-sm">{i.name}</div>
                  <div className="text-xs text-ink-faint">{i.duration}</div>
                </td>
                <td>
                  <Price value={i.unit_price} fx={ctx?.fx} size="text-sm" />
                </td>
                <td className="text-xs text-ink-soft">{t("web.warranty_days", { days: i.warranty_days })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card card-pad mb-5 max-w-md ml-auto text-sm">
        <div className="flex justify-between py-1">
          <span className="text-ink-soft">Subtotal</span> <span>{formatIdr(order.subtotal)}</span>
        </div>
        {showBulk && (
          <div className="flex justify-between py-1 text-grass-dark">
            <span>Bulk</span> <span>−{formatIdr(order.bulk_discount)}</span>
          </div>
        )}
        {showVoucher && (
          <div className="flex justify-between py-1 text-grass-dark">
            <span>Voucher</span> <span>−{formatIdr(order.discount)}</span>
          </div>
        )}
        <div className="flex justify-between py-2 border-t border-line mt-1 font-semibold">
          <span>{t("web.order_total")}</span> <Price value={order.total} fx={ctx?.fx} size="text-base" />
        </div>
      </div>

      {delivered && (
        <section className="card card-pad border-grass/40">
          <h2 className="section-title flex items-center gap-2">
            <BadgeCheck className="w-5 h-5 text-grass" /> {t("web.credentials")}
          </h2>
          <p className="text-xs text-ink-faint mt-1">{t("web.credentials_hint")}</p>
          <div className="mt-3 space-y-2">
            {order.items.map(
              (i, idx) =>
                i.credentials && (
                  <div key={idx} className="flex items-center gap-2">
                    <code className="codeish flex-1 text-sm! break-all select-all">{i.credentials}</code>
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      onClick={() => navigator.clipboard.writeText(i.credentials ?? "")}
                    >
                      <Copy className="w-3.5 h-3.5" /> {t("web.copy")}
                    </button>
                  </div>
                ),
            )}
          </div>
        </section>
      )}
    </>
  );
}
