/**
 * TSX port of apps/storefront/views/pay.njk + its polled fragment
 * views/_pay_status.njk. Two independent data sources, exactly like the NJK:
 *  - GET /api/v1/orders/:code/pay (`data`) is fetched on mount and on
 *    TanStack's default refetch-on-window-focus — harmless, since the gateway
 *    payload is cached server-side on order.paymentRef, the same as an NJK
 *    page refresh would re-read it. It drives the big payment-instructions
 *    card below and is never refetched by the poll itself. The card's stage
 *    only moves FORWARD when the poll reports a later in-flight stage
 *    (waiting -> confirming -> processing; advanceCardState), so a buyer who
 *    opened the page early is not left on stale copy.
 *  - GET /api/v1/orders/:code/status (`poll`) refetches every 5s and drives
 *    the small #pay-status strip (_pay_status.njk), the delivered redirect,
 *    and that forward-only card advance — until the first
 *    poll response lands, the strip shows `data.state` (the same value the
 *    NJK's server-rendered include used before HTMX's first poll tick).
 * pay.njk's inline countdown script computes mm:ss (never negative — clamped
 * to 0:00 once expired) from `order.expires_at_iso`; ported as a
 * setInterval-driven hook producing the identical text. Cancel is a plain
 * POST with no confirm() dialog (checked the template — pay.njk wraps it in
 * nothing but a form). Markup/classes copied verbatim apart from the
 * mechanical Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md):
 * `!text-2xl`/`!text-base` → trailing `!`, `flex-shrink-0` → `shrink-0`.
 *
 * Wallet top-up (Task 5) reuses this component AS-IS rather than forking it —
 * payView()/payState() (routes/checkout.ts) only ever read `Order` columns,
 * never `items`, so their JSON shape is identical for a WALLET_TOPUP order.
 * The `variant` prop below is the one seam: it swaps which API base this page
 * fetches from and the handful of "where do I go next" destinations that
 * genuinely differ between a product order (has a My-Orders detail page, a
 * cart to return to) and a top-up (neither exists — it settles onto the
 * account/wallet balance instead).
 *
 * Design-system migration + cancel-order confirmation (Task 14): composed
 * layout (no page-templates.md reference — see deviations.md
 * §14-pay-topup-track). Cancel now opens `<AlertDialog>` instead of firing
 * `cancelMutation.mutate()` directly on click — the one logic addition this
 * task makes (Global Constraints; Task 1 audit §F item 3); the mutation
 * itself, and every fetch/poll/state-machine/countdown mechanism below, is
 * byte-unchanged.
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
  Mail,
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
import { formatOrderAmount, formatPriceFor, showsUsdDisplay } from "../lib/format";
import { useShopContext } from "../lib/useShopContext";
import { readCodeEmailed } from "../lib/orderCodeEmailed";
import Stepper from "../components/shop/Stepper";
import ErrorPage from "./ErrorPage";
import Skeleton from "../components/shop/Skeleton";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import Badge from "../components/ui/Badge";
import AlertDialog from "../components/ui/AlertDialog";

/**
 * TSX port of _pay_status.njk — the polled status chip. Design-system
 * migration (Task 14): now `Badge`-driven. Tone-per-state is UNCHANGED from
 * the pre-migration markup above — `waiting`→`pending` (amberx),
 * `confirming`→`info` (pine, the one new Badge variant this task adds — an
 * existing token, not an invented color), `delivered`→`success` (grass),
 * `expired`→`failed` (rust), `closed`→`neutral` (sand). See
 * deviations.md §14-pay-topup-track for a note on a divergence this
 * surfaced against business-adaptation.md's order-level Entity States
 * table, deliberately NOT corrected here (out of scope for a re-skin).
 */
function StatusStrip({ state }: { state: PayState }) {
  if (state === "waiting") {
    return (
      <Badge variant="pending" icon={<Clock className="w-3.5 h-3.5" />}>
        {t("web.status_waiting")}
      </Badge>
    );
  }
  if (state === "confirming") {
    return (
      <Badge variant="info" icon={<Loader className="w-3.5 h-3.5 animate-spin" />}>
        {t("web.status_confirming")}
      </Badge>
    );
  }
  if (state === "processing") {
    return (
      <Badge variant="info" icon={<Loader className="w-3.5 h-3.5 animate-spin" />}>
        {t("web.status_processing")}
      </Badge>
    );
  }
  if (state === "delivered") {
    return (
      <Badge variant="success" icon={<BadgeCheck className="w-3.5 h-3.5" />}>
        {t("web.status_paid")}
      </Badge>
    );
  }
  if (state === "expired") {
    return (
      <Badge variant="failed" icon={<TimerOff className="w-3.5 h-3.5" />}>
        {t("web.status_expired")}
      </Badge>
    );
  }
  return <Badge variant="neutral">{t("web.status_closed")}</Badge>;
}

const IN_FLIGHT_RANK: Partial<Record<PayState, number>> = { waiting: 0, confirming: 1, processing: 2 };

/** Which state the big card shows: the polled one only when it is a LATER
 * in-flight stage than the one the card already shows (waiting < confirming <
 * processing). Never moves backwards, and terminal states (delivered/expired/
 * closed) are left to the redirect / existing handling. */
export function advanceCardState(current: PayState, polled: PayState | undefined): PayState {
  const from = IN_FLIGHT_RANK[current];
  const to = polled ? IN_FLIGHT_RANK[polled] : undefined;
  return from !== undefined && to !== undefined && to > from ? (polled as PayState) : current;
}

/** Contact fallback shown when a gateway is down — shared by the TokoPay/
 * PayDisini/NOWPayments gateway_error branches below (pay.njk repeats this
 * exact block three times with the same wa_number → bot_username fallback). */
function GatewayDownFallback({
  payPath,
  titleKey,
  bodyKey,
  waNumber,
  botUsername,
}: {
  /** Full client-side path to reload — `/checkout/:code/pay` for a product
   * order, `/wallet/topup/:code/pay` for a top-up (the two variants' client
   * routes, App.tsx). A plain `<a>` (full reload), not a router Link: the
   * point is to re-fetch the pay view from scratch, same as pay.njk's retry
   * link did. */
  payPath: string;
  titleKey: string;
  bodyKey: string;
  waNumber: string;
  botUsername: string;
}) {
  return (
    <div className="mt-4">
      <Alert variant="banner" tone="warning" title={t(titleKey)}>
        {t(bodyKey)}
      </Alert>
      <div className="flex flex-wrap gap-2">
        <a href={payPath} className="btn btn-soft btn-sm">
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

export default function PayPage({ variant = "order" }: { variant?: "order" | "topup" } = {}) {
  const { code = "" } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const isTopup = variant === "topup";
  // The only seam between the two order kinds — see the file header.
  const apiBase = isTopup ? "/wallet/topup" : "/orders";
  const loginNextBase = isTopup ? "/wallet/topup" : "/checkout";
  const retryHref = isTopup ? "/wallet/topup" : "/cart";
  const retryLabelKey = isTopup ? "web.wallet_topup_retry" : "web.back_to_cart";
  const deliveredHref = isTopup ? "/account" : `/account/orders/${code}`;
  const deliveredLabelKey = isTopup ? "web.wallet_topup_view_wallet" : "web.view_credentials";
  const closedHref = isTopup ? "/account" : "/account/orders";
  const closedLabelKey = isTopup ? "web.account_title" : "web.account_orders";
  // Full-reload retry link for GatewayDownFallback — the client route for
  // this page (App.tsx), not the API base above.
  const payPagePath = isTopup ? `/wallet/topup/${code}/pay` : `/checkout/${code}/pay`;

  const { data, error } = useQuery({
    queryKey: ["pay", apiBase, code],
    queryFn: () => apiGet<PayData>(`/api/v1${apiBase}/${code}/pay`),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign(`/login?next=${loginNextBase}/${code}/pay`);
    }
  }, [error, code, loginNextBase]);

  // Polls every 5s (the HTMX twin); drives the small strip, the
  // delivered-redirect, and advances the big card to a later in-flight stage
  // (see advanceCardState and the file header).
  const { data: poll } = useQuery({
    queryKey: ["pay-status", apiBase, code],
    queryFn: () => apiGet<PayStatusData>(`/api/v1${apiBase}/${code}/status`),
    refetchInterval: 5000,
    enabled: Boolean(data),
  });

  useEffect(() => {
    if (poll?.redirect) navigate(poll.redirect);
  }, [poll, navigate]);

  const cancelMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>(`/api/v1${apiBase}/${code}/cancel`, {}),
    onSuccess: () => navigate(retryHref),
  });

  // The one logic addition Task 14 makes: the cancel button no longer fires
  // cancelMutation directly (Global Constraints / Task 1 audit §F item 3) —
  // it opens this dialog first. onConfirm below calls the exact same
  // mutate() call the old onClick did.
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  const countdownText = useCountdown(data?.order.expires_at_iso ?? null);

  // Display-currency preference + rate, for the "Price · Pay" line below only.
  const { data: ctx } = useShopContext();

  // "We emailed this code to <address>" — the guest order-code mail
  // (routes/api.ts sendGuestOrderCodeEmail). The notice belongs HERE and not
  // on the checkout page: a successful guest checkout leaves the SPA by full
  // page load, so the only screen the buyer can actually read it on is this
  // one, where the code it is about is already printed.
  //
  // `null` — SMTP not configured, a send that failed, a signed-in buyer, or
  // simply arriving at this page any other way — renders nothing at all. The
  // shop never promises an email it did not send; without one, the copy stands
  // as it always has and points at the code on screen.
  const emailedTo = code ? readCodeEmailed(code) : null;

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

  const { order } = data;
  const state = advanceCardState(data.state, poll?.state);
  const stripState = poll?.state ?? state;

  // Final-review fix — the web twin of the bot's payAlongsidePriceLine
  // (apps/order-bot/src/util/format.ts), through the same shared
  // `checkout.price_and_pay` key. Only on the IDR-rail branches (QRIS/TokoPay,
  // PayDisini) of an IDR-settled product order, and only when the viewer's
  // display currency actually renders as "$" — the one case where what they
  // see elsewhere differs from what the rail charges. Price is the order's
  // canonical IDR total (pre-fee) converted once; Pay is exactly the payable
  // string already rendered above it via formatOrderAmount — never
  // re-derived, and the payable itself is untouched. Top-ups are excluded:
  // the buyer typed that amount in Rupiah, and the bot adds no such line to
  // its top-up screens either.
  const currency = ctx?.currency ?? null;
  const showPriceAndPay = !isTopup && order.currency !== "USDT" && showsUsdDisplay(currency, ctx?.fx);
  const priceAndPayLine = (payable: string | null) =>
    showPriceAndPay ? (
      <p className="text-sm text-ink-soft mt-1">
        {t("checkout.price_and_pay", {
          price: formatPriceFor(order.total, currency, ctx?.fx),
          pay: formatOrderAmount(payable, order.currency),
        })}
      </p>
    ) : null;

  return (
    <>
      <Stepper step={state === "delivered" ? 3 : 2} />
      <div className="max-w-2xl mx-auto">
        <h1 className="page-title text-2xl! mb-1">{t("web.pay_title")}</h1>
      <p className={emailedTo ? "text-sm text-ink-soft mb-2" : "text-sm text-ink-soft mb-5"}>
        {t("web.order_code")}: <span className="codeish">{order.code}</span>
      </p>

      {/* Directly under the code it is about, so the sentence and its subject
          are read together. Quiet by design — it is reassurance, not an action
          competing with the payment instructions below it. */}
      {emailedTo && (
        <p className="mb-5 flex items-start gap-1.5 text-xs leading-relaxed text-ink-soft">
          <Mail className="mt-0.5 w-3.5 h-3.5 shrink-0 text-grass" />
          <span>{t("web.pay_code_emailed", { email: emailedTo })}</span>
        </p>
      )}

      <div id="pay-status" className="mb-5">
        <StatusStrip state={stripState} />
      </div>

      {state === "waiting" && (
        <>
          <Card>
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
                      <span>{formatOrderAmount(order.total, order.currency)}</span>
                    </div>
                    <div className="text-sm text-ink-soft flex justify-between">
                      <span>{t("web.qris_admin_fee")}</span>
                      <span>{formatOrderAmount(order.qris_admin_fee, order.currency)}</span>
                    </div>
                    <div className="font-display font-semibold text-pine text-2xl mt-1">
                      {formatOrderAmount(order.qris_grand_total, order.currency)}
                    </div>
                    {priceAndPayLine(order.qris_grand_total)}
                  </>
                ) : (
                  <>
                    <div className="font-display font-semibold text-pine text-2xl">
                      {formatOrderAmount(order.total, order.currency)}
                    </div>
                    {priceAndPayLine(order.total)}
                  </>
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
                    payPath={payPagePath}
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
                <div className="font-display font-semibold text-pine text-2xl">
                  {formatOrderAmount(order.total, order.currency)}
                </div>
                {priceAndPayLine(order.total)}
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
                    payPath={payPagePath}
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
                    payPath={payPagePath}
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
          </Card>

          <div className="mt-4 text-center">
            <Button
              variant="ghost"
              className="text-rust"
              disabled={cancelMutation.isPending}
              onClick={() => setCancelDialogOpen(true)}
            >
              {t("web.cancel_order")}
            </Button>
          </div>

          {/* The required behavior change (Task 14): open a confirmation
              instead of firing cancelMutation.mutate() straight from the
              trigger's onClick. onConfirm below is the EXACT SAME call the
              old direct-execute onClick made — see the diff self-check note
              in deviations.md §14-pay-topup-track. */}
          <AlertDialog
            open={cancelDialogOpen}
            onCancel={() => setCancelDialogOpen(false)}
            onConfirm={() => cancelMutation.mutate()}
            title={t("web.cancel_order_confirm_title")}
            description={t("web.cancel_order_confirm_body", { code: order.code })}
            confirmLabel={t("web.cancel_order_confirm_yes")}
            cancelLabel={t("web.cancel_order_confirm_no")}
            tone="danger"
            confirmPending={cancelMutation.isPending}
          />
        </>
      )}

      {state === "delivered" && (
        <Card className="text-center py-10">
          <BadgeCheck className="w-12 h-12 text-grass mx-auto mb-3" />
          <h2 className="section-title">{t("web.pay_done_title")}</h2>
          <p className="text-sm text-ink-soft mt-1">{t("web.pay_done_sub")}</p>
          <Link to={deliveredHref} className="btn btn-primary mt-5">
            {t(deliveredLabelKey)} <ChevronRight className="w-4 h-4" />
          </Link>
        </Card>
      )}

      {state === "confirming" && (
        <Card className="text-center py-10">
          <Loader className="w-10 h-10 text-pine mx-auto mb-3 animate-spin" />
          <p className="text-sm font-medium text-ink">{t("web.pay_confirming")}</p>
          <p className="text-xs text-ink-soft mt-2">{t("web.pay_confirming_sub")}</p>
        </Card>
      )}

      {state === "processing" && (
        <Card className="text-center py-10">
          <Loader className="w-10 h-10 text-pine mx-auto mb-3 animate-spin" />
          <p className="text-sm font-medium text-ink">{t("web.pay_processing")}</p>
          <p className="text-xs text-ink-soft mt-2">{t("web.pay_processing_sub")}</p>
          {!isTopup && (
            <Link to={deliveredHref} className="btn btn-soft mt-4">
              {t("web.pay_processing_view_order")} <ChevronRight className="w-4 h-4" />
            </Link>
          )}
        </Card>
      )}

      {state === "expired" && (
        <Card className="text-center py-10">
          <TimerOff className="w-10 h-10 text-rust mx-auto mb-3" />
          <p className="text-sm text-ink-soft">{t("web.pay_expired")}</p>
          <Link to={retryHref} className="btn btn-primary mt-4">
            {t(retryLabelKey)}
          </Link>
        </Card>
      )}

      {state === "closed" && (
        <Card className="text-center py-10">
          <p className="text-sm text-ink-soft">{t("web.pay_closed")}</p>
          <Link to={closedHref} className="btn btn-soft mt-4">
            {t(closedLabelKey)}
          </Link>
        </Card>
      )}
      </div>
    </>
  );
}
