/**
 * TSX port of apps/storefront/views/pay.njk + its polled fragment
 * views/_pay_status.njk. Two independent data sources, exactly like the NJK:
 *  - GET /api/v1/orders/:code/pay (`data`) is fetched on mount and on
 *    TanStack's default refetch-on-window-focus — harmless, since the gateway
 *    payload is cached server-side on order.paymentRef, the same as an NJK
 *    page refresh would re-read it. It drives the big payment-instructions
 *    card below and is never refreshed by the poll itself.
 *  - GET /api/v1/orders/:code/status (`poll`) refetches every 5s and drives
 *    ONLY the small #pay-status strip (_pay_status.njk) — until the first
 *    poll response lands, the strip shows `data.state` (the same value the
 *    NJK's server-rendered include used before HTMX's first poll tick).
 * pay.njk's inline countdown script computes mm:ss (never negative — clamped
 * to 0:00 once expired) from `order.expires_at_iso`; ported as a
 * setInterval-driven hook producing the identical text. Cancel is a plain
 * POST with no confirm() dialog (checked the template — pay.njk wraps it in
 * nothing but a form). Markup/classes copied verbatim apart from the
 * mechanical Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md):
 * `!text-2xl`/`!text-base` → trailing `!`, `flex-shrink-0` → `shrink-0`.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BadgeCheck,
  ChevronRight,
  Clock,
  Loader,
  MessageCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  Timer,
  TimerOff,
  Wallet,
} from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { PayData, PayState, PayStatusData } from "../api/types";
import { t } from "../lib/i18n";
import { formatIdr } from "../lib/format";
import Stepper from "../components/shop/Stepper";
import ErrorPage from "./ErrorPage";
import Spinner from "../components/shop/Spinner";
import Skeleton from "../components/shop/Skeleton";

/** TSX port of _pay_status.njk — the polled status chip. */
function StatusStrip({ state }: { state: PayState }) {
  if (state === "waiting") {
    return (
      <div className="chip bg-amberx-tint text-amberx">
        <Clock className="w-3.5 h-3.5" /> {t("web.status_waiting")}
      </div>
    );
  }
  if (state === "confirming") {
    return (
      <div className="chip bg-pine-tint text-pine-dark">
        <Loader className="w-3.5 h-3.5 animate-spin" /> {t("web.status_confirming")}
      </div>
    );
  }
  if (state === "delivered") {
    return (
      <div className="chip bg-grass-tint text-grass-dark">
        <BadgeCheck className="w-3.5 h-3.5" /> {t("web.status_paid")}
      </div>
    );
  }
  if (state === "expired") {
    return (
      <div className="chip bg-rust-tint text-rust-dark">
        <TimerOff className="w-3.5 h-3.5" /> {t("web.status_expired")}
      </div>
    );
  }
  return <div className="chip bg-sand text-ink-soft">{t("web.status_closed")}</div>;
}

/** Contact fallback shown when a gateway is down — shared by the TokoPay/
 * PayDisini/NOWPayments gateway_error branches below (pay.njk repeats this
 * exact block three times with the same wa_number → bot_username fallback). */
function GatewayDownFallback({
  code,
  titleKey,
  bodyKey,
  waNumber,
  botUsername,
}: {
  code: string;
  titleKey: string;
  bodyKey: string;
  waNumber: string;
  botUsername: string;
}) {
  return (
    <div className="mt-4 rounded-xl border border-amberx/30 bg-amberx-tint/60 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amberx shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold text-ink">{t(titleKey)}</p>
          <p className="text-ink-soft mt-0.5 leading-relaxed">{t(bodyKey)}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        <a href={`/checkout/${code}/pay`} className="btn btn-soft btn-sm">
          <RefreshCw className="w-3.5 h-3.5" /> {t("web.pay_retry")}
        </a>
        {waNumber ? (
          <a
            href={`https://wa.me/${waNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost btn-sm"
          >
            <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
          </a>
        ) : botUsername ? (
          <a
            href={`https://t.me/${botUsername}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost btn-sm"
          >
            <Send className="w-3.5 h-3.5" /> Telegram
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** Ports pay.njk's inline countdown script: clamps to 0 (never negative),
 * mm:ss text, stops ticking once expired instead of going negative. */
function useCountdown(expiresAtIso: string | null): string {
  const [text, setText] = useState("--:--");
  useEffect(() => {
    if (!expiresAtIso) return undefined;
    const end = new Date(expiresAtIso).getTime();
    const tick = (): number => {
      const left = Math.max(0, Math.floor((end - Date.now()) / 1000));
      const m = Math.floor(left / 60);
      const s = left % 60;
      setText(`${m}:${String(s).padStart(2, "0")}`);
      return left;
    };
    if (tick() <= 0) return undefined;
    const id = setInterval(() => {
      if (tick() <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAtIso]);
  return text;
}

export default function PayPage() {
  const { code = "" } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const { data, error } = useQuery({
    queryKey: ["pay", code],
    queryFn: () => apiGet<PayData>(`/api/v1/orders/${code}/pay`),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign(`/login?next=/checkout/${code}/pay`);
    }
  }, [error, code]);

  // Polls every 5s (the HTMX twin); only drives the small strip + the
  // delivered-redirect, never the big card below (see file header).
  const { data: poll } = useQuery({
    queryKey: ["pay-status", code],
    queryFn: () => apiGet<PayStatusData>(`/api/v1/orders/${code}/status`),
    refetchInterval: 5000,
    enabled: Boolean(data),
  });

  useEffect(() => {
    if (poll?.redirect) navigate(poll.redirect);
  }, [poll, navigate]);

  const cancelMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>(`/api/v1/orders/${code}/cancel`, {}),
    onSuccess: () => navigate("/cart"),
  });

  const countdownText = useCountdown(data?.order.expires_at_iso ?? null);

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    return null;
  }
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <Skeleton className="mb-6 h-8 w-56" />
        <Skeleton className="mx-auto h-72 w-full max-w-md" />
      </div>
    );
  }

  const { order, state } = data;
  const stripState = poll?.state ?? state;

  return (
    <>
      <Stepper step={state === "delivered" ? 3 : 2} />
      <div className="max-w-2xl mx-auto">
        <h1 className="page-title text-2xl! mb-1">{t("web.pay_title")}</h1>
      <p className="text-sm text-ink-soft mb-5">
        {t("web.order_code")}: <span className="codeish">{order.code}</span>
      </p>

      <div id="pay-status" className="mb-5">
        <StatusStrip state={stripState} />
      </div>

      {state === "waiting" && (
        <>
          <div className="card card-pad">
            {data.is_binance ? (
              <>
                <h2 className="section-title mb-3">{t("web.pay_usdt_title")}</h2>
                <ol className="text-sm text-ink-soft space-y-3 list-decimal pl-4">
                  <li>{t("web.binance_step_open")}</li>
                  <li>
                    {t("web.binance_step_uid")}
                    <div className="codeish text-base! mt-1 select-all break-all">{data.binance_uid}</div>
                  </li>
                  <li>
                    {t("web.binance_step_amount")}
                    <div className="font-display font-semibold text-pine text-2xl mt-1">${order.total}</div>
                  </li>
                  <li>
                    {t("web.binance_step_note")}
                    <div className="codeish text-base! mt-1 select-all break-all">{order.payment_ref}</div>
                  </li>
                </ol>
                <p className="text-xs text-ink-faint mt-4">{t("web.binance_auto_note")}</p>
              </>
            ) : data.is_bybit ? (
              <>
                <h2 className="section-title mb-3">{t("web.pay_bybit_title")}</h2>
                <p className="text-sm text-ink-soft mt-2">{t("web.pay_bybit_amount")}</p>
                <div className="font-display font-semibold text-pine text-2xl mt-1">${order.total}</div>
                {data.bybit_uid && (
                  <>
                    <p className="text-sm text-ink-soft mt-3">{t("web.pay_bybit_uid")}</p>
                    <div className="codeish text-base! mt-1 select-all break-all">{data.bybit_uid}</div>
                  </>
                )}
                <p className="text-xs text-ink-faint mt-4">{t("web.pay_bybit_note")}</p>
              </>
            ) : data.is_bybit_bsc ? (
              <>
                <h2 className="section-title mb-3">{t("web.pay_bybit_bsc_title")}</h2>
                <p className="text-sm text-ink-soft mt-2">{t("web.pay_bybit_bsc_amount")}</p>
                <div className="font-display font-semibold text-pine text-2xl mt-1">${order.total}</div>
                {data.bybit_bsc_address && (
                  <>
                    <p className="text-sm text-ink-soft mt-3">{t("web.pay_bybit_bsc_address")}</p>
                    <div className="codeish text-base! mt-1 select-all break-all">{data.bybit_bsc_address}</div>
                    <p className="text-xs text-amberx mt-2">{t("web.pay_bybit_bsc_chain_warning")}</p>
                  </>
                )}
                <p className="text-xs text-ink-faint mt-4">{t("web.pay_bybit_bsc_note")}</p>
              </>
            ) : data.is_qris ? (
              <>
                <h2 className="section-title mb-3">{t("web.pay_idr_title")}</h2>
                {order.qris_admin_fee != null ? (
                  <>
                    <div className="text-sm text-ink-soft flex justify-between">
                      <span>{t("web.subtotal")}</span>
                      <span>{formatIdr(order.total)}</span>
                    </div>
                    <div className="text-sm text-ink-soft flex justify-between">
                      <span>{t("web.qris_admin_fee")}</span>
                      <span>{formatIdr(order.qris_admin_fee)}</span>
                    </div>
                    <div className="font-display font-semibold text-pine text-2xl mt-1">
                      {formatIdr(order.qris_grand_total)}
                    </div>
                  </>
                ) : (
                  <div className="font-display font-semibold text-pine text-2xl">{formatIdr(order.total)}</div>
                )}
                {data.gateway ? (
                  <>
                    {data.gateway.qrLink && (
                      <div className="mt-4 flex justify-center">
                        <img
                          src={data.gateway.qrLink}
                          alt="QRIS"
                          className="w-56 h-56 rounded-xl border border-line bg-white p-2"
                        />
                      </div>
                    )}
                    {data.gateway.payUrl && (
                      <a href={data.gateway.payUrl} target="_blank" rel="noopener" className="btn btn-primary w-full mt-4">
                        <Wallet className="w-4 h-4" /> {t("web.pay_open_gateway")}
                      </a>
                    )}
                    <p className="text-xs text-ink-faint mt-3">{t("web.tokopay_auto_note")}</p>
                  </>
                ) : data.gateway_error ? (
                  <GatewayDownFallback
                    code={order.code}
                    titleKey="web.pay_idr_down_title"
                    bodyKey="web.pay_idr_down_body"
                    waNumber={data.wa_number}
                    botUsername={data.bot_username}
                  />
                ) : null}
              </>
            ) : data.is_paydisini ? (
              <>
                <h2 className="section-title mb-3">{t("web.pay_paydisini_title")}</h2>
                <div className="font-display font-semibold text-pine text-2xl">{formatIdr(order.total)}</div>
                {data.paydisini_gateway ? (
                  <>
                    {data.paydisini_gateway.qrUrl && (
                      <div className="mt-4 flex justify-center">
                        <img
                          src={data.paydisini_gateway.qrUrl}
                          alt="QRIS"
                          className="w-56 h-56 rounded-xl border border-line bg-white p-2"
                        />
                      </div>
                    )}
                    {data.paydisini_gateway.checkoutUrl && (
                      <a
                        href={data.paydisini_gateway.checkoutUrl}
                        target="_blank"
                        rel="noopener"
                        className="btn btn-primary w-full mt-4"
                      >
                        <Wallet className="w-4 h-4" /> {t("web.pay_open_gateway")}
                      </a>
                    )}
                    <p className="text-xs text-ink-faint mt-3">{t("web.paydisini_auto_note")}</p>
                  </>
                ) : data.paydisini_gateway_error ? (
                  <GatewayDownFallback
                    code={order.code}
                    titleKey="web.pay_idr_down_title"
                    bodyKey="web.pay_idr_down_body"
                    waNumber={data.wa_number}
                    botUsername={data.bot_username}
                  />
                ) : null}
              </>
            ) : data.is_nowpayments ? (
              <>
                <h2 className="section-title mb-3">{t("web.pay_nowpayments_title")}</h2>
                <div className="font-display font-semibold text-pine text-2xl">${order.total}</div>
                {data.nowpayments_gateway ? (
                  <>
                    {data.nowpayments_gateway.invoiceUrl && (
                      <a
                        href={data.nowpayments_gateway.invoiceUrl}
                        target="_blank"
                        rel="noopener"
                        className="btn btn-primary w-full mt-4"
                      >
                        <Wallet className="w-4 h-4" /> {t("web.pay_open_gateway")}
                      </a>
                    )}
                    <p className="text-xs text-ink-faint mt-3">{t("web.nowpayments_auto_note")}</p>
                  </>
                ) : data.nowpayments_gateway_error ? (
                  <GatewayDownFallback
                    code={order.code}
                    titleKey="web.pay_nowpayments_down_title"
                    bodyKey="web.pay_nowpayments_down_body"
                    waNumber={data.wa_number}
                    botUsername={data.bot_username}
                  />
                ) : null}
              </>
            ) : (
              <>
                <p className="text-sm text-ink-soft">{t("web.pay_method_elsewhere")}</p>
                {data.bot_username && (
                  <a
                    href={`https://t.me/${data.bot_username}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-soft btn-sm mt-3"
                  >
                    <Send className="w-3.5 h-3.5" /> Telegram
                  </a>
                )}
              </>
            )}

            {data.min_amount && (
              <p className="text-xs text-amberx mt-3 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                {t("web.pay_min_amount_note", { min: data.min_amount })}
              </p>
            )}

            <div className="flex items-center gap-2 mt-4 text-xs text-ink-faint">
              <ShieldCheck className="w-3.5 h-3.5 text-grass" />
              {t("web.pay_trust")}
            </div>

            {order.expires_at_iso && (
              <div className="flex items-center gap-2 mt-5 pt-4 border-t border-line text-sm text-ink-soft">
                <Timer className="w-4 h-4 text-amberx" />
                {t("web.pay_countdown")}
                <span id="countdown" className="font-mono font-semibold text-ink">
                  {countdownText}
                </span>
              </div>
            )}
          </div>

          <form onSubmit={(e) => e.preventDefault()} className="mt-4 text-center">
            <button
              type="button"
              className="btn btn-ghost text-rust"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              {cancelMutation.isPending && <Spinner />}
              {t("web.cancel_order")}
            </button>
          </form>
        </>
      )}

      {state === "delivered" && (
        <div className="card card-pad text-center py-10">
          <BadgeCheck className="w-12 h-12 text-grass mx-auto mb-3" />
          <h2 className="section-title">{t("web.pay_done_title")}</h2>
          <p className="text-sm text-ink-soft mt-1">{t("web.pay_done_sub")}</p>
          <Link to={`/account/orders/${order.code}`} className="btn btn-primary mt-5">
            {t("web.view_credentials")} <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {state === "confirming" && (
        <div className="card card-pad text-center py-10">
          <Loader className="w-10 h-10 text-pine mx-auto mb-3 animate-spin" />
          <p className="text-sm font-medium text-ink">{t("web.pay_confirming")}</p>
          <p className="text-xs text-ink-soft mt-2">{t("web.pay_confirming_sub")}</p>
        </div>
      )}

      {state === "expired" && (
        <div className="card card-pad text-center py-10">
          <TimerOff className="w-10 h-10 text-rust mx-auto mb-3" />
          <p className="text-sm text-ink-soft">{t("web.pay_expired")}</p>
          <Link to="/cart" className="btn btn-primary mt-4">
            {t("web.back_to_cart")}
          </Link>
        </div>
      )}

      {state === "closed" && (
        <div className="card card-pad text-center py-10">
          <p className="text-sm text-ink-soft">{t("web.pay_closed")}</p>
          <Link to="/account/orders" className="btn btn-soft mt-4">
            {t("web.account_orders")}
          </Link>
        </div>
      )}
      </div>
    </>
  );
}
