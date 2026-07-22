/**
 * TSX port of apps/storefront/views/order_detail.njk. The summary's
 * "Subtotal"/"Bulk"/"Voucher" labels were literal English in the NJK and were
 * ported that way to stay 1:1; they now go through `t()` against the
 * `web.subtotal` / `web.bulk_discount` / `web.voucher_discount` keys the
 * checkout summary was already using, so an Indonesian visitor no longer meets
 * three stray English words in the middle of a localized page.
 * Copy-to-clipboard for a credential reads straight
 * from the item's own value instead of round-tripping through the DOM (the
 * NJK used `getElementById` only because it had no other handle on the
 * string). Markup/classes copied verbatim apart from the mechanical
 * Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md): `!text-2xl`
 * → `text-2xl!`, `!text-sm` → `text-sm!`.
 *
 * Task 10 additions (the storefront twin of the bot's
 * editCustomerInfoConversation, Task 9):
 *  - Polls every 5s ONLY while the order is PROCESSING (function-form
 *    refetchInterval, PayPage's polling precedent) + a manual Refresh button
 *    — belt-and-suspenders, matching the bot's automatic-and-on-demand UX.
 *  - A PROCESSING reassurance card (payment received, being hand-prepared,
 *    deliberately no SLA/ETA number — matches Task 4's DM and Task 9's bot
 *    screen).
 *  - For a manual_with_info order, the buyer's submitted answers are shown
 *    read-only, with an Edit control enabled only while PROCESSING (locked
 *    once DELIVERED). The edit form reuses DeliveryFieldInput (shared with
 *    CheckoutPage's info-collection step) and lib/deliveryFields.ts's
 *    client-side validation. The server (updateOrderCustomerData) is the
 *    final authority — a ValidationError response (including the mid-edit
 *    race, error.order_not_processing, if the order left PROCESSING while
 *    the buyer was editing) shows the translated error and refetches so the
 *    buyer sees the server's real current state; the race case additionally
 *    exits edit mode since editing is now locked. The buyer's in-progress
 *    typing is never silently discarded — `answers` is local state, seeded
 *    only when Edit is first tapped, so a refetch never clobbers it.
 *  - For a manually-fulfilled DELIVERED order, `delivered_content` renders in
 *    its own titled, copyable block (same copy-to-clipboard shape as the
 *    credentials block below it, but visually and textually distinct so it
 *    doesn't read as stock credentials).
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, BadgeCheck, Clock, Copy, Pencil, RefreshCw, Wallet } from "lucide-react";
import { apiGet, apiPatch } from "../api/client";
import type { OrderDetailData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t, currentLang } from "../lib/i18n";
import { formatIdr } from "../lib/format";
import { allFieldsValid } from "../lib/deliveryFields";
import { useIsDesktop } from "../lib/useMediaQuery";
import Price from "../components/shop/Price";
import Skeleton from "../components/shop/Skeleton";
import StatusBadge from "../components/shop/StatusBadge";
import DeliveryFieldInput from "../components/shop/DeliveryFieldInput";
import ErrorPage from "./ErrorPage";
import Spinner from "../components/shop/Spinner";

export default function OrderDetailPage() {
  const { code = "" } = useParams<{ code: string }>();
  const { data: ctx } = useShopContext();
  const isDesktop = useIsDesktop();
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ["account-order", code],
    queryFn: () => apiGet<OrderDetailData>(`/api/v1/account/orders/${code}`),
    retry: false,
    // Poll only while awaiting hand fulfilment — off for every other status
    // (PayPage's 5s-poll precedent, function-form so it re-evaluates the
    // LATEST fetched status on every tick instead of freezing at mount time).
    refetchInterval: (query) => (query.state.data?.order.status === "PROCESSING" ? 5000 : false),
  });

  const [editMode, setEditMode] = useState(false);
  const [answers, setAnswers] = useState<Array<Record<string, string>>>([]);
  const [infoErrorKey, setInfoErrorKey] = useState<string | null>(null);

  const infoMutation = useMutation({
    mutationFn: (customerData: Array<Record<string, string>>) =>
      apiPatch<{ ok: boolean }>(`/api/v1/account/orders/${code}/info`, { customer_data: customerData }),
    onSuccess: () => {
      setEditMode(false);
      setInfoErrorKey(null);
      void refetch();
    },
    onError: (err) => {
      const key = (err as Error).message;
      setInfoErrorKey(key);
      void refetch();
      // The mid-edit race: the order left PROCESSING while the buyer was
      // editing (e.g. an admin fulfilled it). Editing is now locked — exit
      // the form instead of leaving a dead Save button behind. Any other
      // (unlikely, since the client already validates) field error re-prompts
      // in place so the buyer can fix it without losing their other answers.
      if (key === "error.order_not_processing") setEditMode(false);
    },
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
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <Skeleton className="mb-6 h-8 w-56" />
        <div className="card mb-5 space-y-3 p-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
        <Skeleton className="mb-5 h-40 w-full" />
        <Skeleton className="ml-auto h-32 w-full max-w-md" />
      </div>
    );
  }

  const { order, delivered, pending_payment: pendingPayment, processing } = data;
  const showBulk = Boolean(order.bulk_discount) && order.bulk_discount !== "0";
  const showVoucher = Boolean(order.discount) && order.discount !== "0";
  const qty = order.items.length;
  const fields = order.customer_data_fields;

  function startEdit(): void {
    setAnswers(Array.from({ length: qty }, (_, unitIdx) => ({ ...(order.customer_data[unitIdx] ?? {}) })));
    setInfoErrorKey(null);
    setEditMode(true);
  }

  function cancelEdit(): void {
    setEditMode(false);
    setInfoErrorKey(null);
  }

  function setAnswer(unitIdx: number, key: string, value: string): void {
    setAnswers((prev) => {
      const next = prev.slice();
      next[unitIdx] = { ...next[unitIdx], [key]: value };
      return next;
    });
  }

  const infoValid = allFieldsValid(fields, answers, qty);
  const lang = currentLang();

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

      {processing && (
        <div className="card card-pad mb-5 flex items-center justify-between gap-3 flex-wrap bg-pine-tint/40">
          <div className="flex items-start gap-3">
            <Clock className="w-5 h-5 text-pine mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-ink">{t("web.order_processing_title")}</div>
              <div className="text-xs text-ink-soft mt-0.5">{t("web.order_processing_body")}</div>
            </div>
          </div>
          <button type="button" className="btn btn-soft btn-sm" disabled={isFetching} onClick={() => void refetch()}>
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} /> {t("web.order_refresh")}
          </button>
        </div>
      )}

      {/* Item lines: stacked on a phone, the three-column table from md up.
          Only one of the two is ever in the DOM (lib/useMediaQuery.ts). */}
      {isDesktop ? (
        <div className="card mb-5">
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
      ) : (
        <ul className="card mb-5 divide-y divide-line">
          {order.items.map((i, idx) => (
            <li key={idx} className="p-4">
              <div className="text-sm font-semibold text-ink">{i.name}</div>
              {i.duration && <div className="text-xs text-ink-faint">{i.duration}</div>}
              <div className="mt-2 flex items-center justify-between gap-3">
                <Price value={i.unit_price} fx={ctx?.fx} size="text-sm" />
                <span className="text-xs text-ink-soft">{t("web.warranty_days", { days: i.warranty_days })}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="card card-pad mb-5 max-w-md ml-auto text-sm">
        <div className="flex justify-between py-1">
          <span className="text-ink-soft">{t("web.subtotal")}</span> <span>{formatIdr(order.subtotal)}</span>
        </div>
        {showBulk && (
          <div className="flex justify-between py-1 text-grass-dark">
            <span>{t("web.bulk_discount")}</span> <span>−{formatIdr(order.bulk_discount)}</span>
          </div>
        )}
        {showVoucher && (
          <div className="flex justify-between py-1 text-grass-dark">
            <span>{t("web.voucher_discount")}</span> <span>−{formatIdr(order.discount)}</span>
          </div>
        )}
        <div className="flex justify-between py-2 border-t border-line mt-1 font-semibold">
          <span>{t("web.order_total")}</span> <Price value={order.total} fx={ctx?.fx} size="text-base" />
        </div>
      </div>

      {fields.length > 0 && (
        <section className="card card-pad mb-5">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
            <h2 className="section-title">{t("web.order_info_title")}</h2>
            {processing && !editMode && (
              <button type="button" className="btn btn-soft btn-sm" onClick={startEdit}>
                <Pencil className="w-3.5 h-3.5" /> {t("web.order_info_edit_btn")}
              </button>
            )}
          </div>

          {infoErrorKey && (
            <div className="card card-pad border-rust/40 bg-rust-tint text-rust-dark text-sm mt-3">
              <AlertTriangle className="w-4 h-4" /> {t(infoErrorKey)}
            </div>
          )}

          {editMode ? (
            <>
              <div className="space-y-5 mt-3">
                {Array.from({ length: qty }, (_, unitIdx) => (
                  <div key={unitIdx} className={qty > 1 ? "border border-line rounded-xl p-3" : ""}>
                    {qty > 1 && (
                      <div className="text-xs font-semibold text-ink-soft mb-2">
                        {t("web.checkout_info_unit", { unit: unitIdx + 1, total: qty })}
                      </div>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2">
                      {fields.map((field) => (
                        <DeliveryFieldInput
                          key={field.key}
                          field={field}
                          inputId={`edit-info-${unitIdx}-${field.key}`}
                          value={answers[unitIdx]?.[field.key] ?? ""}
                          onChange={(value) => setAnswer(unitIdx, field.key, value)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-4">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!infoValid || infoMutation.isPending}
                  onClick={() => infoMutation.mutate(answers)}
                >
                  {infoMutation.isPending && <Spinner />}
                  {t("web.order_info_save_btn")}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={infoMutation.isPending}
                  onClick={cancelEdit}
                >
                  {t("web.order_info_cancel_btn")}
                </button>
              </div>
            </>
          ) : (
            <div className="mt-3 space-y-3 text-sm">
              {order.customer_data.map((unitAnswers, unitIdx) => (
                <div key={unitIdx}>
                  {qty > 1 && (
                    <div className="text-xs font-semibold text-ink-soft mb-1">
                      {t("web.checkout_info_unit", { unit: unitIdx + 1, total: qty })}
                    </div>
                  )}
                  <dl className="space-y-1">
                    {fields.map((field) => (
                      <div key={field.key} className="flex justify-between gap-3">
                        <dt className="text-ink-soft">{lang === "id" ? field.label.id : field.label.en}</dt>
                        <dd className="font-medium text-right">{unitAnswers[field.key] ?? ""}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {delivered && (
        <section className="card card-pad border-grass/40 mb-5">
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

      {delivered && order.delivered_content && (
        <section className="card card-pad border-grass/40">
          <h2 className="section-title flex items-center gap-2">
            <BadgeCheck className="w-5 h-5 text-grass" /> {t("web.delivered_content_title")}
          </h2>
          <p className="text-xs text-ink-faint mt-1">{t("web.delivered_content_hint")}</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="codeish flex-1 text-sm! break-all whitespace-pre-wrap select-all">
              {order.delivered_content}
            </code>
            <button
              type="button"
              className="btn btn-soft btn-sm"
              onClick={() => navigator.clipboard.writeText(order.delivered_content ?? "")}
            >
              <Copy className="w-3.5 h-3.5" /> {t("web.copy")}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
