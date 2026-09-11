/**
 * TSX port of apps/storefront/views/checkout.njk + its embedded totals
 * partial views/_checkout_totals.njk. checkout.njk's inline <script>
 * intercepts Enter on #voucher_code so it previews the voucher instead of
 * submitting the real order (see the onKeyDown handler below) — ported as a
 * plain event handler since none of our buttons are type="submit" anyway.
 *
 * State is split the same way the HTMX swap split the page: `page` (payment
 * method radios) is set ONCE from the initial GET and never touched again —
 * the voucher-preview response only ever swapped #checkout-summary in the
 * NJK, never the method radios. `totals` mirrors that #checkout-summary
 * fragment: initialized from the same GET, then replaced wholesale by every
 * voucher-preview response (subtotal/discounts/total + the method-enabled
 * flags _checkout_totals.njk uses to gate the Place Order button). The
 * voucher input itself is a THIRD, independent piece of state — its live
 * typed value is what Place Order submits, whether or not Apply/Enter was
 * ever pressed, exactly like the NJK's hx-include="closest form" left the
 * input's value untouched by the swap.
 *
 * Wallet credit ("Wallet Credit (IDR)"/"Wallet Credit (USDT)") is just two
 * more entries in the same method radio group — all-or-nothing, only
 * rendered when that currency's balance covers the live (post-voucher)
 * total. Selecting one and hitting "Place order & pay" posts
 * method: "wallet_idr"/"wallet_usdt" to the same /api/v1/checkout endpoint
 * gateway methods use; the server (routes/api.ts) branches to the no-gateway
 * performWalletCheckout path before ever looking at a voucher/customer_data.
 *
 * Markup/classes copied verbatim apart from the mechanical Tailwind v3→v4
 * renames (docs/REACT_STOREFRONT_MIGRATION.md), with two deliberate mobile
 * departures from template parity documented at PaymentMethodRow (selected
 * state) and at the sticky total bar near the bottom of this file.
 *
 * Design-system migration (Fase 7c): `GuestContactCard`/`InfoStepCard`'s
 * `.card.card-pad` surfaces are now `<Card>`; the page-level place-order
 * error banner is `<Alert variant="banner" tone="error">`. `GuestContactCard`
 * composes `<Label>` + `<Input>` directly rather than a literal `<FormField>`
 * (same reasoning as OrderSummaryCard's voucher field): the label row also
 * carries a "Required" badge and the card header carries a sign-in link,
 * neither of which FormField's single-child clone/label contract has room
 * for. The mobile sticky total bar is now the shared `<StickyPurchaseBar>`
 * (Task 11) instead of a hand-rolled `fixed` div — it portals out of `<main>`,
 * fixing the same containing-block bug Task 11's doc comment describes — and
 * the form's own reserved-runway padding switched from an inline
 * `calc(env(safe-area-inset-bottom) + …)` style to a plain `pb-28` utility:
 * StickyPurchaseBar already pads its own bottom for the safe area, so the
 * page only has to clear the bar's visible height, not re-derive the notch
 * geometry itself. See deviations.md §13-checkout.
 */
import { useEffect, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ShoppingCart } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import { useIdempotentPost } from "../api/idempotency";
import type { AdditionalField, CheckoutData, PlaceOrderResponse } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { formatIdr } from "../lib/format";
import { rememberCodeEmailed } from "../lib/orderCodeEmailed";
import { allFieldsValid, isValidEmail } from "../lib/deliveryFields";
import { useIsDesktop } from "../lib/useMediaQuery";
import { useSuggestedProducts } from "../lib/useSuggestedProducts";
import EmptyState from "../components/shop/EmptyState";
import Skeleton from "../components/shop/Skeleton";
import Stepper from "../components/shop/Stepper";
import DeliveryFieldInput from "../components/shop/DeliveryFieldInput";
import StickyPurchaseBar from "../components/shop/StickyPurchaseBar";
import PaymentMethodSelector, {
  anyMethodEnabled,
  defaultMethod,
  isIdrWalletSufficient,
  isUsdtWalletSufficient,
} from "../components/shop/PaymentMethodSelector";
import OrderSummaryCard from "../components/shop/OrderSummaryCard";
import Card from "../components/ui/Card";
import Label from "../components/ui/Label";
import Input from "../components/ui/Input";
import Alert from "../components/ui/Alert";
import { cn } from "../components/ui/cn";

/**
 * Turn whatever an API rejection carried into something a shopper can read.
 *
 * The server's own failures arrive as i18n keys ("error.rate_limited",
 * "web.guest_email_invalid"), which `t()` renders. Anything else is the API
 * client's developer-facing fallback ("/api/v1/checkout responded 500") or a
 * network error, and `t()` would hand that string straight back — so those
 * become the generic apology instead. Guest checkout widened the set of
 * failures this page can hit (throttles on an anonymous read, a session
 * minted mid-request), which is what makes the distinction worth making.
 */
function humanError(message: string): string {
  return message.startsWith("web.") || message.startsWith("error.") ? t(message) : t("web.error_message");
}

/**
 * Info-collection step (Task 6, item 1): for the ONE manual_with_info line a
 * cart may hold (single-SKU-per-non-auto-cart guard, routes/api.ts POST
 * /cart), collects `additional_fields` answers once per unit (qty times) —
 * inline form sections, not a multi-step wizard (this is a web page, unlike
 * the bot's chat-turn "Unit N of M" wizard it conceptually mirrors). Renders
 * ABOVE the payment card, gating "Place Order" until every unit validates.
 * Client-side validation (lib/deliveryFields.ts) is a UX convenience only —
 * the server re-validates from scratch before persisting (routes/checkout.ts
 * performCheckout).
 */
function InfoStepCard({
  fields,
  qty,
  answers,
  onChange,
}: {
  fields: AdditionalField[];
  qty: number;
  answers: Array<Record<string, string>>;
  onChange: (unitIdx: number, key: string, value: string) => void;
}) {
  // STO-010: buying multiple units of the same manual_with_info product for
  // yourself is common — copy Unit 1's answers into every other unit rather
  // than making the buyer retype the same email N times.
  function copyToAll(): void {
    const first = answers[0] ?? {};
    for (let unitIdx = 1; unitIdx < qty; unitIdx++) {
      for (const field of fields) {
        onChange(unitIdx, field.key, first[field.key] ?? "");
      }
    }
  }

  return (
    <Card>
      <h2 className="section-title mb-1">{t("web.checkout_info_title")}</h2>
      <p className="text-xs text-ink-soft mb-3">{t("web.checkout_info_intro")}</p>
      <div className="space-y-5">
        {Array.from({ length: qty }, (_, unitIdx) => (
          <div key={unitIdx} className={qty > 1 ? "border border-line rounded-xl p-3" : ""}>
            {qty > 1 && (
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-xs font-semibold text-ink-soft">
                  {t("web.checkout_info_unit", { unit: unitIdx + 1, total: qty })}
                </div>
                {unitIdx === 0 && (
                  <button
                    type="button"
                    className="text-xs font-medium text-pine transition-colors hover:text-pine-dark underline shrink-0"
                    onClick={copyToAll}
                  >
                    {t("web.checkout_info_copy_all")}
                  </button>
                )}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((field) => (
                <DeliveryFieldInput
                  key={field.key}
                  field={field}
                  inputId={`info-${unitIdx}-${field.key}`}
                  value={answers[unitIdx]?.[field.key] ?? ""}
                  onChange={(value) => onChange(unitIdx, field.key, value)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Guest checkout's one extra question. Deliberately not a gate: the sign-in
 * link is an offer sitting beside the field, not a door in front of it, and
 * the hint says what the address is FOR rather than just demanding it.
 *
 * This field is one of the three things that hold "Place order" back, and the
 * only one whose blocker isn't self-evident on the page (the other two are a
 * visibly empty method list and a visibly incomplete info step). So it carries
 * its own explanation, in two layers:
 *
 *  - A "Required" marker beside the label, visible from first paint. The
 *    native `required` attribute cannot do this job: the submit is a
 *    `type="button"` inside a form that preventDefaults, so the browser never
 *    runs constraint validation and never shows its own bubble.
 *  - An inline error, but only AFTER the shopper has left the field (or the
 *    server has rejected the address) — the same "don't scold someone who
 *    hasn't typed yet" rule DeliveryFieldInput follows. `aria-describedby`
 *    points at it whenever it's showing, so a screen reader hears the reason
 *    rather than a bare "invalid".
 */
export function GuestContactCard({
  email,
  onChange,
  serverRejected,
}: {
  email: string;
  onChange: (value: string) => void;
  /** The server came back with `web.guest_email_invalid` for this address. */
  serverRejected: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const showError = serverRejected || (touched && !isValidEmail(email));
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="section-title">{t("web.guest_contact_title")}</h2>
        <Link
          to="/login?next=/checkout"
          className="text-sm font-medium text-pine underline transition-colors hover:text-pine-dark"
        >
          {t("web.guest_have_account")}
        </Link>
      </div>
      {/* The marker sits OUTSIDE the <label>, so the field's accessible name
          stays "Email address" and `required` carries the semantics for
          assistive tech; this text is the sighted half of the same fact. Composed
          from <Label>/<Input> directly rather than a literal <FormField> — the
          label row also carries this "Required" badge, which FormField's
          single-child clone/label contract has no slot for (same reasoning as
          OrderSummaryCard's voucher field). */}
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor="guest_email">{t("web.guest_email_label")}</Label>
        <span className="text-xs text-ink-faint">{t("web.field_required")}</span>
      </div>
      <Input
        id="guest_email"
        type="email"
        invalid={showError}
        value={email}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTouched(true)}
        autoComplete="email"
        inputMode="email"
        placeholder="you@example.com"
        aria-describedby={showError ? "guest_email_error guest_email_hint" : "guest_email_hint"}
        required
      />
      {showError && (
        <p id="guest_email_error" className="mt-2 flex items-center gap-1.5 text-sm text-rust-dark">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {t("web.guest_email_invalid")}
        </p>
      )}
      <p id="guest_email_hint" className="mt-2 text-xs leading-relaxed text-ink-soft">
        {t("web.guest_email_hint")}
      </p>
    </Card>
  );
}

export default function CheckoutPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: ctx } = useShopContext();
  // Decides which of the two submit controls exists — see the sticky bar below.
  const isDesktop = useIsDesktop();
  const { data, error } = useQuery({
    queryKey: ["checkout"],
    queryFn: () => apiGet<CheckoutData>("/api/v1/checkout"),
    retry: false,
  });

  const [page, setPage] = useState<CheckoutData | null>(null);
  const [totals, setTotals] = useState<CheckoutData | null>(null);
  const [voucherInput, setVoucherInput] = useState("");
  const [method, setMethod] = useState<string | null>(null);
  const [placeOrderErrorKey, setPlaceOrderErrorKey] = useState<string | null>(null);
  // Guest checkout only — a registered buyer never sees the field, and the
  // value is never sent for them (the server ignores it anyway).
  const [guestEmail, setGuestEmail] = useState("");
  // One answer-map per unit for the manual_with_info info step — [] when the
  // cart has no such line (the section then renders nothing).
  const [answers, setAnswers] = useState<Array<Record<string, string>>>([]);

  // No 401 redirect to /login any more: GET /api/v1/checkout serves anonymous
  // visitors (guest checkout), so being signed out is a normal state of this
  // page rather than an error to bounce out of. Any failure that DOES happen
  // (a 429 from the anonymous read throttle, a network blip) is rendered
  // below instead of leaving the visitor on a blank page.

  // First load only: seed both halves of the split state, the voucher input,
  // and the default method selection. Never re-runs once `page` is set —
  // later GETs of this query (e.g. a background refetch) must not clobber
  // whatever the buyer has since typed/selected.
  useEffect(() => {
    if (data && !page) {
      setPage(data);
      setTotals(data);
      setVoucherInput(data.voucher_code ?? "");
      setMethod(defaultMethod(data));
      const infoItem = data.items.find((i) => i.delivery_type === "manual_with_info");
      if (infoItem) setAnswers(Array.from({ length: infoItem.qty }, () => ({})));
    }
  }, [data, page]);

  // Fetched only once the cart is known to be empty at checkout — never
  // delays the empty-cart card itself, which paints from `page` alone. Not
  // the "checkout unavailable" error branch below: that's a failed load, not
  // a normal empty state, and the user was explicit that it stays shelf-free.
  const { data: suggested } = useSuggestedProducts(page?.items_empty === true);

  // Only the order-creating call below goes through this — the voucher
  // preview is a pure re-price that creates nothing, so replaying it would
  // buy nothing and pin a stale quote.
  const idempotentPost = useIdempotentPost();

  const previewMutation = useMutation({
    mutationFn: (voucherCode: string) =>
      apiPost<CheckoutData>("/api/v1/checkout/voucher/preview", { voucher_code: voucherCode }),
    onSuccess: (resp) => setTotals(resp),
  });

  function applyVoucher(): void {
    previewMutation.mutate(voucherInput);
  }

  function onVoucherKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // Mirrors checkout.njk's inline script exactly: ignore Enter presses that
    // are really an IME composing an East-Asian character, not a real submit.
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    applyVoucher();
  }

  // Drives both gateway methods and wallet credit ("wallet_idr"/"wallet_usdt"
  // — just two more radio values) — the server branches on `method` before
  // ever looking at voucher_code/customer_data for the wallet case.
  //
  // `idempotentPost`, not `apiPost`: this is the one call on the page that
  // creates an order (and, for a guest, an account), so a retry after a
  // request that never came back must replay the first attempt instead of
  // buying twice. See api/idempotency.ts for when the key is held and when a
  // fresh one is minted — in short, an unanswered attempt at the identical
  // request keeps its key, and every edit the buyer makes here (method,
  // voucher, guest email, info answers) starts a new one.
  const placeOrderMutation = useMutation({
    mutationFn: () =>
      idempotentPost<PlaceOrderResponse>("/api/v1/checkout", {
        method,
        voucher_code: voucherInput,
        customer_data: page?.items.some((i) => i.delivery_type === "manual_with_info") ? answers : undefined,
        // Sent only in guest mode. The server treats it as the guest account's
        // contact address and ignores it entirely for a signed-in buyer.
        guest_email: page?.is_guest ? guestEmail.trim() : undefined,
      }),
    onSuccess: (resp) => {
      // The server mails a guest their order code and reports, in
      // `email_sent`, whether the mail actually went out (SMTP is optional per
      // deployment, and a send can fail). Strictly `=== true`: an absent flag
      // is a signed-in 201, and the one thing this notice must never do is
      // promise an email nobody received.
      //
      // It is HANDED OVER rather than rendered, because the guest success path
      // below leaves the page entirely — anything rendered here would be torn
      // down before it could be read. PayPage picks it up beside the very code
      // that was mailed. The address travels through sessionStorage and not
      // the URL: it is the buyer's email, and a query parameter would leak it
      // into access logs, `Referer` headers, history and shared links.
      if (resp.email_sent === true) rememberCodeEmailed(resp.order_code, guestEmail.trim());

      // Anyone checking out in guest mode leaves the SPA entirely, the way
      // LoginPage does, instead of routing client-side: the shell was rendered
      // for an anonymous visitor, so the account menu, cart ownership and the
      // CSRF meta tag are all wrong until it is re-served.
      //
      // `page.is_guest` and not just `resp.csrf_token`: the token comes back
      // only on the request that MINTS the session. On a retry (a first
      // attempt that failed after minting) the server takes its signed-in
      // branch and sends none, so keying on the token alone left the shopper
      // navigating client-side under a shell that still offered "Sign in".
      //
      // A genuinely signed-in buyer matches neither condition and keeps the
      // instant client-side navigation they have today.
      if (resp.csrf_token || page?.is_guest) window.location.assign(resp.pay_url);
      else navigate(resp.pay_url);
    },
    onError: (err) => {
      setPlaceOrderErrorKey((err as Error).message);
      // Guest checkout establishes the session BEFORE it tries to place the
      // order, and establishing it migrates the cookie cart into CartItem rows
      // and clears the cookie (routes/auth.ts establishSession). That ordering
      // is deliberate — performCheckout reads the cart from the database — but
      // it means a failure here leaves the cached /pages/context describing a
      // visitor who no longer exists: anonymous, with a cookie-counted cart of
      // zero. The header would offer "Sign in" and the cart badge would read 0
      // while a live session and a full server-side cart sat behind them.
      // Re-reading the context fixes both without disturbing that ordering.
      // Signed-in buyers minted nothing and moved nothing, so they skip the
      // extra request.
      if (page?.is_guest) void queryClient.invalidateQueries({ queryKey: ["context"] });
    },
  });

  // Nothing loaded yet, and nothing went wrong: a placeholder shaped like the
  // page, not the blank screen this used to render while the query was in
  // flight (STO-006 / performance.md, same treatment as OrdersPage).
  if (!page || !totals) {
    if (!error) {
      return (
        <div aria-busy="true" aria-label={t("web.loading")}>
          <Skeleton className="mb-5 h-8 w-48" />
          <div className="grid items-start gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <Card className="space-y-3">
                <Skeleton className="h-5 w-40" />
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-xl" />
                ))}
              </Card>
              <Card className="space-y-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-10 w-full" />
              </Card>
            </div>
            <Card className="space-y-3">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-10 w-full" />
            </Card>
          </div>
        </div>
      );
    }
    // The checkout payload never arrived — most likely the anonymous read
    // throttle (429). Say so in words the buyer can act on and give them
    // somewhere to go, rather than leaving an empty page or a bare error key.
    return (
      <>
        <Stepper step={2} />
        <h1 className="page-title text-2xl! mb-5">{t("web.checkout_title")}</h1>
        <EmptyState
          icon={AlertTriangle}
          title={t("web.checkout_unavailable")}
          description={humanError((error as Error).message)}
          action={{ label: t("web.back_to_cart"), to: "/cart" }}
          secondaryAction={{ label: t("web.nav_products"), to: "/products" }}
        />
      </>
    );
  }

  // An empty cart used to bounce to /cart. For a guest that is one navigation
  // to an equally empty screen — say it here, where they are, and name the way
  // forward. Never render a payment form for a cart with nothing in it.
  if (page.items_empty) {
    return (
      <>
        <Stepper step={2} />
        <h1 className="page-title text-2xl! mb-5">{t("web.checkout_title")}</h1>
        <EmptyState
          icon={ShoppingCart}
          title={t("web.checkout_empty_title")}
          description={t("web.cart_empty_desc")}
          action={{ label: t("web.nav_products"), to: "/products" }}
          secondaryAction={{ label: t("web.back_to_cart"), to: "/cart" }}
          suggestions={suggested ? { products: suggested.products, fx: ctx?.fx, lowThreshold: suggested.low_threshold } : undefined}
        />
      </>
    );
  }

  // Wallet-credit radios — only offered when credit fully covers the live
  // total (post-voucher); hidden (not disabled) otherwise.
  const idrWalletSufficient = isIdrWalletSufficient(totals);
  const usdtWalletSufficient = isUsdtWalletSufficient(totals);
  const anyMethod = anyMethodEnabled(totals) || idrWalletSufficient || usdtWalletSufficient;
  // Info step (Task 6): the single-SKU-per-non-auto-cart guard means there's
  // ever at most one manual_with_info line.
  const infoItem = page.items.find((i) => i.delivery_type === "manual_with_info") ?? null;
  const infoValid = !infoItem || allFieldsValid(infoItem.additional_fields, answers, infoItem.qty);
  // Both submit controls share one set of gates so neither can offer an order
  // the other refuses: `blocked` is the permanent "not payable yet" state the
  // dimmed styling explains, `disabled` adds the transient in-flight state.
  // Client-side courtesy only — it saves a wasted round trip; the server
  // re-validates and owns `web.guest_email_invalid`.
  const guestEmailValid = !page.is_guest || isValidEmail(guestEmail);
  const placeOrderBlocked = !anyMethod || !infoValid || !guestEmailValid;
  const placeOrderDisabled = placeOrderBlocked || placeOrderMutation.isPending;

  function setAnswer(unitIdx: number, key: string, value: string): void {
    setAnswers((prev) => {
      const next = prev.slice();
      next[unitIdx] = { ...next[unitIdx], [key]: value };
      return next;
    });
  }

  return (
    <>
      <Stepper step={2} />
      <h1 className="page-title text-2xl! mb-5">{t("web.checkout_title")}</h1>

      {/* A rejected guest email is rendered against the field it belongs to
          instead (GuestContactCard) — same reasoning as STO-005 moved the
          voucher error out of the summary column: repeating the identical
          sentence in a page-level banner is noise, and the banner is a whole
          column away from the input the buyer has to fix. */}
      {placeOrderErrorKey && !(page.is_guest && placeOrderErrorKey === "web.guest_email_invalid") && (
        <Alert variant="banner" tone="error">
          {humanError(placeOrderErrorKey)}
        </Alert>
      )}

      <form
        onSubmit={(e) => e.preventDefault()}
        // The sticky bar is fixed (out of flow) and would otherwise sit on top
        // of the last thing in the form ("Back to cart") — reserve its visible
        // height at the end of the page instead. StickyPurchaseBar already
        // pads its own bottom for the iOS safe area, so this only needs a
        // plain utility, not a re-derived env()/calc() of its own.
        className={cn("grid lg:grid-cols-3 gap-6 items-start", !isDesktop && "pb-28")}
      >
        <div className="lg:col-span-2 space-y-6">
          {/* First card in the column for a guest: the shop needs to know
              where the order goes before anything about paying for it. */}
          {page.is_guest && (
            <GuestContactCard
              email={guestEmail}
              onChange={setGuestEmail}
              serverRejected={placeOrderErrorKey === "web.guest_email_invalid"}
            />
          )}

          {infoItem && (
            <InfoStepCard fields={infoItem.additional_fields} qty={infoItem.qty} answers={answers} onChange={setAnswer} />
          )}
        </div>

        <OrderSummaryCard
          totals={totals}
          method={method}
          fx={ctx?.fx}
          voucherInput={voucherInput}
          onVoucherInputChange={setVoucherInput}
          onVoucherApply={applyVoucher}
          onVoucherKeyDown={onVoucherKeyDown}
          voucherPending={previewMutation.isPending}
          showDesktopSubmit={isDesktop}
          submitLabel={t("web.place_order")}
          submitDisabled={placeOrderDisabled}
          submitBlocked={placeOrderBlocked}
          onSubmit={() => placeOrderMutation.mutate()}
          submitPending={placeOrderMutation.isPending}
          backTo={{ label: t("web.back_to_cart"), to: "/cart" }}
        />

        {/* Payment method — full-width row below both columns (Task 5): see
            InstantBuyPage.tsx's matching call site for the grid-auto-placement
            reasoning on why this must stay in DOM order AFTER OrderSummaryCard.
            `totals`, not `page` — `page` is seeded once from the initial GET
            and never updated, so gating the wallet-credit rows on it would use
            a stale, pre-voucher total; `totals` is the live payload (re-set on
            every voucher-preview response) and shares every other field
            (gateway flags, wallet balances) with `page` — only
            `total`/`total_usdt` differ, which is exactly what needs to be live
            for wallet-sufficiency to track the applied voucher. */}
        <div className="lg:col-span-3">
          <PaymentMethodSelector data={totals} method={method} onSelect={setMethod} />
        </div>
      </form>

      {/* Sticky mobile total: on a phone the summary card stacks *below* the method
          list, so the buyer chooses a payment rail with the amount they are
          about to pay scrolled off-screen — the one number that should never
          leave view on a checkout. The shared StickyPurchaseBar (Task 11)
          pins the live total (the same `totals.total` the summary renders,
          after any voucher preview) next to the only submit control mobile
          has, reusing the summary button's mutation and gating verbatim: no
          second request path, no second notion of "ready to pay". Desktop
          keeps the in-card button — there the summary sits beside the methods
          and is already in view. The IDR figure only, matching the previous
          hand-rolled bar: the USDT hint stays in the summary card, where
          there is room for it without crowding the button off a 320px row. */}
      {!isDesktop && (
        <StickyPurchaseBar
          ariaLabel={t("web.purchase_bar")}
          priceLabel={t("web.order_total")}
          price={formatIdr(method === "qris" ? totals.qris_grand_total : totals.total)}
          primaryAction={{
            label: t("web.place_order"),
            onClick: () => placeOrderMutation.mutate(),
            pending: placeOrderMutation.isPending,
            disabled: placeOrderDisabled,
            blocked: placeOrderBlocked,
          }}
        />
      )}
    </>
  );
}
