/** Order detail uses canonical backend fulfillment, full-detail SSE refetches
 * and five-second polling while payment or delivery is outstanding.
 * Historical amounts preserve their settlement and central-IDR bases. */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BadgeCheck, Clock, Copy, Pencil, RefreshCw, Wallet } from "lucide-react";
import { apiGet, apiPatch } from "../api/client";
import type { OrderDetailData } from "../api/types";
import { t, currentLang } from "../lib/i18n";
import { tError } from "../lib/errors";
import { formatIdr, formatOrderAmount } from "../lib/format";
import { allFieldsValid } from "../lib/deliveryFields";
import { useIsDesktop } from "../lib/useMediaQuery";
import { isOrderLive } from "../lib/orderFulfillment";
import { useOrderStatusStream } from "../hooks/useOrderStatusStream";
import Skeleton from "../components/shop/Skeleton";
import StatusBadge from "../components/shop/StatusBadge";
import OrderProgress from "../components/shop/OrderProgress";
import DeliveryFieldInput from "../components/shop/DeliveryFieldInput";
import ErrorPage from "./ErrorPage";
import Spinner from "../components/shop/Spinner";
import Alert from "../components/ui/Alert";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";

export default function OrderDetailPage() {
  const { code = "" } = useParams<{ code: string }>();
  const isDesktop = useIsDesktop();
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ["account-order", code],
    queryFn: () => apiGet<OrderDetailData>(`/api/v1/account/orders/${code}`),
    retry: false,
    refetchInterval: (query) => (isOrderLive(query.state.data) ? 5000 : false),
  });

  const stream = useOrderStatusStream(code, isOrderLive(data));

  const [editMode, setEditMode] = useState(false);
  const [answers, setAnswers] = useState<Array<Record<string, string>>>([]);
  // The rejection itself: a field error like `error.text_too_long` quotes the
  // limit it was judged by, and that figure rides on the Error (F4a).
  const [infoError, setInfoError] = useState<unknown>(null);
  // The server is authoritative, but once the order has been handed to a
  // provider (or finished) the buyer must never be offered an editor, even for
  // the instant before a stale flag refreshes.
  const dispatched = ["SUBMITTING", "PROCESSING", "SUCCESS"].includes(data?.order.fulfillment?.status ?? "");
  const canEdit = !data?.read_only && !dispatched && (data?.order.fulfillment?.can_edit_customer_data ?? Boolean(data?.processing));

  useEffect(() => {
    if (!canEdit) setEditMode(false);
  }, [canEdit]);

  const infoMutation = useMutation({
    mutationFn: (customerData: Array<Record<string, string>>) =>
      apiPatch<{ ok: boolean }>(`/api/v1/account/orders/${code}/info`, { customer_data: customerData }),
    onSuccess: () => {
      setEditMode(false);
      setInfoError(null);
      void refetch();
    },
    onError: (err) => {
      const key = (err as Error).message;
      setInfoError(err);
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

  useEffect(() => {
    if (data && window.location.hash === "#credentials") {
      document.getElementById("credentials")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [data]);

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
  // Wallet credit is a reduction like the two above it, and it was the one row
  // missing from this stack: an order paid from the balance printed a subtotal
  // and its discounts above a Total that was lower by the whole credit, with
  // nothing on the page accounting for the difference. The server now derives
  // these figures so they reconcile exactly — see
  // apps/storefront/src/routes/buyerOrderSummary.ts.
  const showWallet = Boolean(order.wallet_credit) && order.wallet_credit !== "0";
  const qty = order.items.length;
  const fields = order.customer_data_fields;

  function startEdit(): void {
    setAnswers(Array.from({ length: qty }, (_, unitIdx) => ({ ...(order.customer_data[unitIdx] ?? {}) })));
    setInfoError(null);
    setEditMode(true);
  }

  function cancelEdit(): void {
    setEditMode(false);
    setInfoError(null);
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
  const liveUpdates = isOrderLive(data) ? (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-ink-faint">
      <span className="min-w-0 break-words">
        {stream.disconnected ? (
          <>
            {t("web.order_live_disconnected")}{" "}
            <button type="button" className="min-h-11 px-2 font-semibold text-pine hover:underline" onClick={stream.retry}>
              {t("web.order_live_retry")}
            </button>
          </>
        ) : (
          t("web.order_updates_automatic")
        )}
      </span>
      <button
        type="button"
        aria-label={t("web.order_refresh")}
        title={t("web.order_refresh")}
        disabled={isFetching}
        onClick={() => void refetch()}
        className="grid min-h-11 min-w-11 place-items-center rounded-lg text-ink-faint hover:bg-sand hover:text-ink disabled:opacity-60"
      >
        <RefreshCw aria-hidden="true" className={`h-4 w-4 ${isFetching ? "animate-spin motion-reduce:animate-none" : ""}`} />
      </button>
    </div>
  ) : null;

  return (
    <div className="min-w-0">
      <div className="mb-6 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-ink-faint mb-2 break-words">
            <Link to="/account/orders" className="hover:text-pine">
              {t("web.account_orders")}
            </Link>
            <span className="mx-1">/</span> <span className="font-mono">{order.code}</span>
          </div>
          <h1 className="page-title block! break-words">
            {t("web.order_code")} <span className="font-mono break-all">{order.code}</span>
          </h1>
          {data.recovery_url && <a className="text-sm underline" href={data.recovery_url}>{t("web.save_recovery_link")}</a>}
        </div>
        <StatusBadge value={order.status} fulfillment={order.fulfillment} />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {order.fulfillment && <OrderProgress fulfillment={order.fulfillment} underpayment={order.underpayment}>{liveUpdates}</OrderProgress>}
          {pendingPayment && (
            <Card className="flex items-center justify-between gap-3 flex-wrap bg-pine-tint/40">
              <div className="text-sm text-ink-soft">
                {t("web.order_status")}: <StatusBadge value={order.status} fulfillment={order.fulfillment} />
              </div>
              <Link to={`/checkout/${order.code}/pay`} className="btn btn-primary min-h-11">
                <Wallet className="w-4 h-4" /> {t("web.pay_now")}
              </Link>
            </Card>
          )}

          {processing && !order.fulfillment && (
            <Card className="flex items-center justify-between gap-3 flex-wrap bg-pine-tint/40">
              <div className="flex items-start gap-3">
                <Clock className="w-5 h-5 text-pine mt-0.5 shrink-0" />
                <div>
                  <div className="text-sm font-semibold text-ink">{t("web.order_processing_title")}</div>
                  <div className="text-xs text-ink-soft mt-0.5">{t("web.order_processing_body")}</div>
                  {order.digiflazz_status === "pending" && (
                    <div className="text-xs text-ink-soft mt-1">{t("web.digiflazz_pending_body")}</div>
                  )}
                  {order.digiflazz_status === "reviewing" && (
                    <div className="text-xs text-ink-soft mt-1">{t("web.digiflazz_failed_body")}</div>
                  )}
                </div>
              </div>
            </Card>
          )}
          {!order.fulfillment && liveUpdates}

          {/* Item lines: stacked on a phone, the three-column table from md up.
              Only one of the two is ever in the DOM (lib/useMediaQuery.ts). */}
          {isDesktop ? (
            <Card padded={false} className="min-w-0 overflow-x-auto">
              <table className="data-table w-full">
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
                        <div className="font-semibold text-sm break-words">{i.name}</div>
                        <div className="text-xs text-ink-faint">{i.duration}</div>
                      </td>
                      <td>
                        <span className="font-semibold text-pine text-sm whitespace-nowrap">{formatIdr(i.unit_price)}</span>
                      </td>
                      <td className="text-xs text-ink-soft">{t("web.warranty_days", { days: i.warranty_days })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : (
            <ul className="card min-w-0 divide-y divide-line">
              {order.items.map((i, idx) => (
                <li key={idx} className="p-4">
                  <div className="text-sm font-semibold text-ink break-words">{i.name}</div>
                  {i.duration && <div className="text-xs text-ink-faint">{i.duration}</div>}
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                    <span className="font-semibold text-pine text-sm whitespace-nowrap">{formatIdr(i.unit_price)}</span>
                    <span className="text-xs text-ink-soft">{t("web.warranty_days", { days: i.warranty_days })}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {fields.length > 0 && (
            <section className="card card-pad min-w-0">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
                <h2 className="section-title">{t("web.order_info_title")}</h2>
                {canEdit && !editMode && (
                  <Button variant="soft" className="min-h-11" onClick={startEdit}>
                    <Pencil className="w-3.5 h-3.5" /> {t("web.order_info_edit_btn")}
                  </Button>
                )}
              </div>

              {infoError !== null && (
                <Alert variant="banner" tone="error" className="mt-3">
                  {tError(infoError)}
                </Alert>
              )}

              {editMode && canEdit ? (
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
                  <div className="flex flex-wrap gap-2 mt-4">
                    <Button
                      variant="primary"
                      className="min-h-11"
                      disabled={!canEdit || !infoValid || infoMutation.isPending}
                      onClick={() => infoMutation.mutate(answers)}
                    >
                      {infoMutation.isPending && <Spinner />}
                      {t("web.order_info_save_btn")}
                    </Button>
                    <Button
                      variant="ghost"
                      className="min-h-11"
                      disabled={infoMutation.isPending}
                      onClick={cancelEdit}
                    >
                      {t("web.order_info_cancel_btn")}
                    </Button>
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
                          <div key={field.key} className="grid grid-cols-2 gap-3">
                            <dt className="text-ink-soft break-words">{lang === "id" ? field.label.id : field.label.en}</dt>
                            <dd className="font-medium text-right break-all">{unitAnswers[field.key] ?? ""}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {delivered && order.items.some((item) => item.credentials) && (
            <section id="credentials" className="card card-pad border-grass/40 mb-5">
              <h2 className="section-title flex items-center gap-2">
                <BadgeCheck className="w-5 h-5 text-grass" /> {t("web.credentials")}
              </h2>
              <p className="text-xs text-ink-faint mt-1">{t("web.credentials_hint")}</p>
              <div className="mt-3 space-y-2">
                {order.items.map(
                  (i, idx) =>
                    i.credentials && (
                      <div key={idx} className="flex flex-wrap items-center gap-2">
                        <code className="codeish min-w-0 flex-1 text-sm! break-all select-all">{i.credentials}</code>
                        <Button
                          variant="soft"
                          className="min-h-11"
                          onClick={() => navigator.clipboard.writeText(i.credentials ?? "")}
                        >
                          <Copy className="w-3.5 h-3.5" /> {t("web.copy")}
                        </Button>
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
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="codeish min-w-0 flex-1 text-sm! break-all whitespace-pre-wrap select-all">
                  {order.delivered_content}
                </code>
                <Button
                  variant="soft"
                  className="min-h-11"
                  onClick={() => navigator.clipboard.writeText(order.delivered_content ?? "")}
                >
                  <Copy className="w-3.5 h-3.5" /> {t("web.copy")}
                </Button>
              </div>
            </section>
          )}
        </div>
        {/* Historical prices and reductions stay in IDR; the total uses the
            order's settlement currency, independent of viewer preference. */}
        <Card className="min-w-0 text-sm lg:sticky lg:top-20">
          <h2 className="section-title mb-3">{t("web.order_summary_title")}</h2>
          <div className="flex flex-wrap justify-between gap-x-3 py-1">
            <span className="text-ink-soft">{t("web.subtotal")}</span> <span>{formatIdr(order.subtotal)}</span>
          </div>
          {showBulk && (
            <div className="flex flex-wrap justify-between gap-x-3 py-1 text-grass-dark">
              <span>{t("web.bulk_discount")}</span> <span>−{formatIdr(order.bulk_discount)}</span>
            </div>
          )}
          {showVoucher && (
            <div className="flex flex-wrap justify-between gap-x-3 py-1 text-grass-dark">
              <span>{t("web.voucher_discount")}</span> <span>−{formatIdr(order.discount)}</span>
            </div>
          )}
          {showWallet && (
            <div className="flex flex-wrap justify-between gap-x-3 py-1 text-grass-dark">
              <span>{t("web.wallet_credit_row")}</span> <span>−{formatIdr(order.wallet_credit)}</span>
            </div>
          )}
          <div className="flex flex-wrap justify-between gap-x-3 py-2 border-t border-line mt-2 font-semibold">
            <span className="text-base">{t("web.order_total")}</span> <span className="font-bold text-pine text-xl whitespace-nowrap">
              {formatOrderAmount(order.total, order.currency)}
            </span>
          </div>
          <p className="mt-3 border-t border-line pt-3 text-xs text-ink-faint">{order.created_at_display}</p>
        </Card>
      </div>
    </div>
  );
}
