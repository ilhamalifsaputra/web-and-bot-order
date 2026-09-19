import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { EmptyState } from "../components/shared/EmptyState";
import { OrderUnitsCard, type StockReplacementRow } from "../components/orders/OrderUnitsCard";
import { StatusBadge } from "../components/shared/StatusBadge";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { RefreshCw, Check, X, CircleDollarSign, Send, MailX, HandCoins } from "lucide-react";
import { toast } from "sonner";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { apiGet, apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";
import { useSse } from "../hooks/useSse";

interface OrderItem {
  id: number;
  quantity: number;
  unitPrice: string;
  product: { id: number; name: string };
  stockItem: { id: number; credentials: string } | null;
}

interface OrderDetail {
  id: number;
  orderCode: string;
  status: string;
  /** "PRODUCT" (normal purchase) or "WALLET_TOPUP" (zero OrderItem rows —
   * the buyer topped up their wallet balance, not bought a SKU). Support
   * needs to see top-ups here, but the Items table below is meaningless for
   * one, so it gets a distinct label instead. */
  kind: string;
  currency: string;
  totalAmount: string;
  createdAt: string;
  createdAtDisplay: string | null;
  /** A guest buyer's row has `isGuest: true` and NO username/fullName/
   * telegramId at all — `guestEmail` is the only identity and the only way
   * to contact them, so every buyer-facing spot here has to handle it. */
  user: {
    id: number;
    fullName: string | null;
    username: string | null;
    telegramId: string | null;
    isGuest: boolean;
    guestEmail: string | null;
  } | null;
  items: OrderItem[];
  voucher: { code: string; type: string } | null;
  /** Set only by a manual/manual_with_info fulfilment (fulfillManualOrder) —
   * always null for auto-delivered orders, which deliver via stockItem
   * instead. The admin's own audit view of what was sent to the buyer. */
  deliveredContent: string | null;
  /** The base GET /api/orders/:orderId response already carries these
   * (getOrder's `include: fullInclude` returns every Order scalar column,
   * not a narrowing `select`) — `optional` here is only because the field
   * predates that response's own type, not because it's ever really absent
   * for a real order. `useSse` (below) keeps these current between
   * fetches for a Digiflazz-routed order; on a genuine order.status
   * change it triggers a full refetch (queryClient.invalidateQueries)
   * rather than merging status directly, so these four fields and the
   * status-derived canAct/canFulfill/canReject/isDelivered booleans can
   * never show a stale combination for longer than one refetch. */
  digiflazzStatus?: string | null;
  digiflazzAttempts?: number;
  digiflazzNextRecheckAt?: string | null;
  digiflazzFailureDetail?: string | null;
}

interface MoneyView {
  currency: string;
  itemsTotal: string;
  bulkDiscount: string | null;
  discount: string | null;
  walletCredit: string | null;
  amountMarker: string | null;
  totalToPay: string;
  equivalentIdr: string | null;
}

/** One admin-defined custom checkout field for a manual_with_info SKU — JSON
 * twin of @app/core/deliveryFields's AdditionalField (mirrored, not
 * cross-imported — same convention as api/types.ts's own copy). */
interface CustomerDataField {
  key: string;
  label: { id: string; en: string };
  type: string;
  required: boolean;
  options: string[];
  placeholder: string;
}

/** Buyer answers, one { fieldKey: value } map per unit — order.customerData
 * parsed and labeled server-side. */
type CustomerDataUnit = Record<string, string>;

interface OrderDetailData {
  order: OrderDetail;
  money: MoneyView;
  isDelivered: boolean;
  canAct: boolean;
  canCredit: boolean;
  /** True once the order is PROCESSING (manual/manual_with_info SKU, paid,
   * awaiting an admin to hand-type and send the account content). */
  canFulfill: boolean;
  /** PENDING_VERIFICATION or PROCESSING — reject is legal from both (the
   * latter is how an admin unsticks a paid manual order they can't source).
   * Distinct from canAct: PROCESSING has no "Approve & Deliver" action. */
  canReject: boolean;
  /** The SKU's custom-field spec (empty for auto orders and manual orders
   * with no custom fields — nothing to render in that case). */
  customerDataFields: CustomerDataField[];
  /** The buyer's answers, one map per unit. */
  customerData: CustomerDataUnit[];
  /** Every "this account is dead" request ever opened against a unit of this
   * order (M20). Empty for the overwhelming majority of orders. `optional`
   * only because older cached/mocked responses predate the field — the live
   * route always sends at least `[]`. */
  stockReplacements?: StockReplacementRow[];
  /** What a payment rail recorded the buyer OVERPAYING on this order, or null
   * (task F2) — null for the overwhelming majority of orders.
   *
   * Every figure here is derived server-side from the rail's own
   * processed-transaction row; the client never sends an amount back, and the
   * action route has no field that could accept one. `optional` only because
   * older cached/mocked responses predate the field. */
  overpayment?: {
    /** Which rail's record this came from — named so an admin can check it. */
    gateway: string;
    receivedAmount: string;
    /** What the order actually billed: the QRIS charge on TokoPay (whose admin
     * fee is a buyer-side surcharge), the bare total everywhere else. */
    expectedAmount: string;
    excess: string;
    currency: string;
    /** True once the excess has been handed back. */
    credited: boolean;
  } | null;
}

function useOrderDetail(orderId: string) {
  return useQuery<OrderDetailData>({
    queryKey: ["order", orderId],
    queryFn: () => apiGet<OrderDetailData>(`/api/orders/${orderId}`),
    enabled: !!orderId,
  });
}

export function OrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const qc = useQueryClient();
  const { data, isError } = useOrderDetail(orderId ?? "");
  useSse<OrderDetailData>(
    orderId ? `/api/orders/${orderId}/digiflazz/stream` : null,
    ["order", orderId],
    (prev, next) => {
      // No base order loaded yet — nothing to merge into. `merge`'s declared
      // return type is T, but this repo's strict TS config rejects casting
      // `undefined` straight to OrderDetailData, so route it through
      // `unknown` — the runtime value is still `undefined`, which
      // setQueryData leaves as-is (there's nothing cached to overwrite).
      if (!prev) return prev as unknown as OrderDetailData;
      const snapshot = next as {
        orderStatus: string;
        digiflazzStatus: string | null;
        digiflazzAttempts: number;
        digiflazzNextRecheckAt: string | null;
        digiflazzFailureDetail: string | null;
      };
      if (snapshot.orderStatus !== prev.order.status) {
        // The order's overall status changed (e.g. a Sukses-driven
        // DELIVERED transition) — canAct/canCredit/canFulfill/canReject/
        // isDelivered are server-computed siblings of order.status, not
        // derivable from this SSE snapshot alone, so a partial merge here
        // would desync them from the badge (Fix 3, final review finding
        // I-3). Invalidate instead: the next refetch brings status and
        // every derived boolean back in lockstep. The four digiflazz*
        // fields below still update immediately via the merge in the
        // meantime, so the sub-status badge doesn't wait on the refetch.
        void qc.invalidateQueries({ queryKey: ["order", orderId] });
      }
      return {
        ...prev,
        order: {
          ...prev.order,
          digiflazzStatus: snapshot.digiflazzStatus,
          digiflazzAttempts: snapshot.digiflazzAttempts,
          digiflazzNextRecheckAt: snapshot.digiflazzNextRecheckAt,
          digiflazzFailureDetail: snapshot.digiflazzFailureDetail,
        },
      };
    },
  );
  const [rejectReason, setRejectReason] = useState("");
  const [fulfillContent, setFulfillContent] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["order", orderId] });

  const approve = useMutation({
    mutationFn: () => apiPost(`/api/orders/${orderId}/approve`, {}),
    onSuccess: () => { refresh(); setActionError(null); },
    onError: (e: Error) => setActionError(describeError(e.message)),
  });

  const reject = useMutation({
    mutationFn: () => apiPost(`/api/orders/${orderId}/reject`, { reason: rejectReason }),
    onSuccess: () => { refresh(); setRejectReason(""); setActionError(null); },
    onError: (e: Error) => setActionError(describeError(e.message)),
  });

  const creditBalance = useMutation({
    mutationFn: () => apiPost(`/api/orders/${orderId}/credit-balance`, {}),
    onSuccess: () => { refresh(); setActionError(null); },
    onError: (e: Error) => setActionError(describeError(e.message)),
  });

  const resend = useMutation({
    mutationFn: () => apiPost(`/api/orders/${orderId}/resend`, {}),
    onSuccess: () => { setActionError(null); },
    onError: (e: Error) => setActionError(describeError(e.message)),
  });

  const fulfill = useMutation({
    mutationFn: () => apiPost(`/api/orders/${orderId}/fulfill`, { content: fulfillContent }),
    onSuccess: () => { refresh(); setFulfillContent(""); setActionError(null); },
    onError: (e: Error) => setActionError(describeError(e.message)),
  });

  /** Hand the buyer back what they overpaid (task F2).
   *
   * The body is deliberately empty: the amount is derived server-side from the
   * rail's own record, and there is no field on that route that could accept one
   * from here. The response carries the figure back so the toast can name what
   * actually moved — the admin never chose it and has no other way to see it. */
  const creditOverpayment = useMutation({
    mutationFn: () =>
      apiPost<{ credited: string; currency: string }>(
        `/api/orders/${orderId}/credit-overpayment`,
        {},
      ),
    onSuccess: (res) => {
      refresh();
      setActionError(null);
      toast.success(
        `Returned ${formatCurrencyDisplay(res.credited, res.currency as "IDR" | "USDT" | "USD")} to the buyer's wallet balance.`,
      );
    },
    onError: (e: Error) => setActionError(describeError(e.message)),
  });

  if (isError) {
    return (
      <PageLayout title="Order Detail">
        <p className="text-sm text-rust">Failed to load order.</p>
      </PageLayout>
    );
  }
  if (!data) {
    return (
      <PageLayout title="Order Detail">
        <p>Loading…</p>
      </PageLayout>
    );
  }

  const { order, money, canAct, canCredit, canFulfill, canReject, isDelivered, customerDataFields, customerData } = data;
  const stockReplacements = data.stockReplacements ?? [];
  const overpayment = data.overpayment ?? null;
  /** Offer the action only while there really is something to hand back — the
   *  same two conditions `creditOverpaymentToBalance` refuses on, so the button
   *  is never shown for a call that would certainly come back 422. A zero excess
   *  can happen on a flagged-but-stale rail row. */
  const canReturnOverpayment =
    overpayment !== null && !overpayment.credited && /[1-9]/.test(overpayment.excess);
  const isWalletTopup = order.kind === "WALLET_TOPUP";
  // A top-up never reserves a stockItem/credentials to resend — there's
  // nothing here for the outbox's account-credentials DM to attach.
  const canResend = isDelivered && order.user?.telegramId != null && !isWalletTopup;
  const hasCustomerData = customerDataFields.length > 0 && customerData.length > 0;
  // Manual/manual_with_info orders never reserve stock (stockItemId stays
  // null for every unit, from checkout through fulfilment) — unlike auto
  // orders, which reserve a stockItem immediately at checkout, well before
  // delivery. A row-of-dashes Credentials column on a manual order is just
  // noise, so hide it there; a real auto order keeps the column exactly as
  // before.
  const isManualOrder = order.items.length > 0 && order.items.every(i => i.stockItem === null);
  // Guest buyers have no name to fall back on, so the Customer row would
  // otherwise render a bare dash — label them explicitly instead, and give
  // their one contact channel its own card below.
  const isGuestBuyer = order.user?.isGuest === true;
  const buyerName = order.user?.fullName ?? order.user?.username ?? null;

  return (
    <PageLayout title={`Order ${order.orderCode}`}>
      <PageHeader
        title={`Order ${order.orderCode}`}
        breadcrumb={[{ label: "Orders", href: "/orders" }]}
      />

      {actionError && <p className="mb-4 text-sm text-rust">{actionError}</p>}

      {/* Order info */}
      <div className="grid grid-cols-1 gap-4 mb-6 sm:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Order Info</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            {isWalletTopup && (
              <div className="flex justify-between">
                <span className="text-ink-soft">Type</span>
                <Badge variant="secondary">Wallet Top-Up ({order.currency})</Badge>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-ink-soft">Status</span>
              <StatusBadge status={order.status} />
            </div>
            {order.digiflazzStatus === "pending_at_supplier" && (
              <div className="flex justify-between">
                <span className="text-ink-soft">Digiflazz</span>
                <Badge variant="secondary">
                  Pending at supplier{order.digiflazzAttempts ? ` (attempt ${order.digiflazzAttempts})` : ""}
                </Badge>
              </div>
            )}
            {order.digiflazzStatus === "failed" && (
              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span className="text-ink-soft">Digiflazz</span>
                  <Badge variant="destructive">Failed — needs manual review</Badge>
                </div>
                {order.digiflazzFailureDetail && (
                  <p className="text-xs text-ink-soft">{order.digiflazzFailureDetail}</p>
                )}
              </div>
            )}
            <div className="flex justify-between gap-4">
              <span className="shrink-0 text-ink-soft">Customer</span>
              <span className="flex min-w-0 items-center gap-2 text-ink">
                {isGuestBuyer && <Badge variant="secondary" className="shrink-0">Guest</Badge>}
                <span className="truncate" title={buyerName ?? undefined}>
                  {buyerName ?? (isGuestBuyer ? "Guest checkout" : "—")}
                </span>
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="shrink-0 text-ink-soft">Telegram ID</span>
              <span className="min-w-0 font-mono text-xs break-all text-ink-soft">{order.user?.telegramId ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-soft">Date</span>
              <span className="text-ink">{order.createdAtDisplay ?? "—"}</span>
            </div>
            {order.voucher && (
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-ink-soft">Voucher</span>
                <span className="min-w-0 font-mono text-xs break-all">{order.voucher.code} ({order.voucher.type})</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Payment</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between">
              <span className="text-ink-soft">Items</span>
              <span>{money.itemsTotal} {money.currency}</span>
            </div>
            {money.bulkDiscount && <div className="flex justify-between"><span className="text-ink-soft">Bulk discount</span><span className="text-rust">−{money.bulkDiscount}</span></div>}
            {money.discount && <div className="flex justify-between"><span className="text-ink-soft">Discount</span><span className="text-rust">−{money.discount}</span></div>}
            {money.walletCredit && <div className="flex justify-between"><span className="text-ink-soft">Wallet credit</span><span className="text-rust">−{money.walletCredit}</span></div>}
            {money.amountMarker && <div className="flex justify-between"><span className="text-ink-soft">Unique cents</span><span>+{money.amountMarker}</span></div>}
            <div className="flex justify-between border-t border-line pt-1 mt-1">
              <span className="font-medium text-ink">Total</span>
              <span className="font-semibold">{money.totalToPay} {money.currency}</span>
            </div>
            {money.equivalentIdr && <div className="flex justify-between"><span className="text-ink-soft">≈ IDR</span><span className="text-ink-soft">{money.equivalentIdr}</span></div>}
          </CardContent>
        </Card>
      </div>

      {/* Overpayment (task F2) — rendered only for the rare order a rail flagged.
          Its own card rather than a row in Payment above, because it is the one
          thing on this page that says the shop is holding money that is not
          its own, and because the action lives with the figures that justify it:
          an admin should be able to check the rail's own numbers before handing
          anything back, not trust a button. */}
      {overpayment !== null && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle as="h2">Overpayment</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p className="text-ink-soft">
              The buyer paid more than this order asked for. {overpayment.gateway} recorded{" "}
              {formatCurrencyDisplay(overpayment.receivedAmount, overpayment.currency as "IDR" | "USDT" | "USD")}{" "}
              arriving against a bill of{" "}
              {formatCurrencyDisplay(overpayment.expectedAmount, overpayment.currency as "IDR" | "USDT" | "USD")}.
            </p>
            <div className="flex justify-between border-t border-line pt-2">
              <span className="font-medium text-ink">Excess</span>
              <span className="font-mono font-semibold">
                {formatCurrencyDisplay(overpayment.excess, overpayment.currency as "IDR" | "USDT" | "USD")}
              </span>
            </div>
            {overpayment.credited ? (
              <p className="text-ink-soft">
                Already returned to the buyer's wallet balance — it shows on the Wallet Ledger as
                "Overpayment returned".
              </p>
            ) : canReturnOverpayment ? (
              <ConfirmDialog
                trigger={
                  <Button size="sm" disabled={creditOverpayment.isPending}>
                    <HandCoins className="h-4 w-4" />
                    Return{" "}
                    {formatCurrencyDisplay(overpayment.excess, overpayment.currency as "IDR" | "USDT" | "USD")}{" "}
                    to the buyer
                  </Button>
                }
                title="Return the overpayment to the buyer?"
                description={`The buyer gets ${formatCurrencyDisplay(overpayment.excess, overpayment.currency as "IDR" | "USDT" | "USD")} as wallet balance, spendable on their next order. The amount comes from ${overpayment.gateway}'s own record and cannot be changed here. This can only be done once, and it cannot be undone.`}
                confirmLabel="Return it"
                variant="default"
                onConfirm={() => creditOverpayment.mutate()}
              />
            ) : (
              // A flagged row whose derived excess is zero: the rail recorded an
              // amount at or below what the order billed, so there is nothing to
              // return. Said plainly rather than offering a button that would be
              // refused.
              <p className="text-ink-soft">
                {overpayment.gateway}'s record does not actually show the buyer paying more than the
                order billed, so there is nothing to return. If they really did overpay, the rail's
                record is what needs looking at first.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Guest contact — only rendered for guest orders (progressive
          disclosure: a registered buyer already has a name and a Telegram id
          in the card above). For a manually-fulfilled guest order this email
          is the ONLY way to reach the buyer, so it gets its own card rather
          than a fourth key/value row an admin has to hunt for. */}
      {isGuestBuyer && (
        <Card className="mb-6">
          <CardHeader><CardTitle>Guest Buyer</CardTitle></CardHeader>
          <CardContent>
            {order.user?.guestEmail ? (
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-ink-soft">Contact email</span>
                <a
                  href={`mailto:${order.user.guestEmail}`}
                  className="w-fit font-medium break-all text-ink underline underline-offset-4"
                >
                  {order.user.guestEmail}
                </a>
                <span className="text-xs text-ink-soft">
                  This buyer checked out without an account — email is the only way to reach them.
                </span>
              </div>
            ) : (
              // guestEmail is nullable in the schema, so an admin can land on
              // a guest order with nothing to contact. Say so plainly instead
              // of leaving the card blank.
              <EmptyState
                icon={MailX}
                title="No contact address on file"
                description="This guest order has no email saved, so the buyer can't be contacted from here. They can still follow the order themselves with its order code on the storefront."
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Items table — a wallet top-up has zero OrderItem rows by design (it
          credits the buyer's wallet balance, not a SKU), so the table is
          replaced with a plain note instead of an empty product grid.
          Everything else (including the per-unit replacement actions M20 added)
          lives in OrderUnitsCard, shared with the support ticket page. */}
      {isWalletTopup ? (
        <EmptyState
          title="No items — this is a wallet top-up"
          description={`This order credited the buyer's wallet balance directly (${order.currency}); it never had products to deliver.`}
        />
      ) : (
        <OrderUnitsCard
          orderId={orderId ?? ""}
          units={order.items}
          replacements={stockReplacements}
          isDelivered={isDelivered}
          showCredentials={!isManualOrder}
        />
      )}

      {/* Buyer-submitted custom checkout info (manual_with_info orders only) */}
      {hasCustomerData && (
        <Card className="mt-6">
          <CardHeader><CardTitle>Buyer-Submitted Info</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {customerData.map((unit, i) => (
              <div key={i} className="flex flex-col gap-1">
                {customerDataFields.map(field => (
                  <div key={field.key} className="flex justify-between gap-4">
                    <span className="shrink-0 text-ink-soft">
                      {customerData.length > 1 ? `Unit ${i + 1} — ${field.label.en}` : field.label.en}
                    </span>
                    {/* Buyer-typed free text — the least predictable value on
                        this page, so it wraps rather than being clipped by the
                        card's overflow-hidden. */}
                    <span className="min-w-0 break-words text-ink text-right">{unit[field.key] || "—"}</span>
                  </div>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Delivered content (manual fulfilment's own audit view — auto orders
          never set this, they deliver via stockItem.credentials above) */}
      {isDelivered && order.deliveredContent != null && (
        <Card className="mt-6">
          <CardHeader><CardTitle>Delivered Content</CardTitle></CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-ink">{order.deliveredContent}</pre>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      {(canAct || canCredit || canResend || canFulfill || canReject) && (
        <Card className="mt-6">
          <CardHeader><CardTitle>Actions</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            {canResend && (
              <ConfirmDialog
                trigger={<Button variant="outline" disabled={resend.isPending}><RefreshCw className="h-4 w-4" />{resend.isPending ? "Resending…" : "Resend to Telegram"}</Button>}
                title="Resend credentials to the buyer?"
                description="Queues a fresh account-credentials message to the buyer's Telegram — use this if they say they never received it."
                confirmLabel="Resend"
                variant="default"
                onConfirm={() => resend.mutate()}
              />
            )}

            {canAct && (
              <ConfirmDialog
                trigger={<Button disabled={approve.isPending}><Check className="h-4 w-4 text-grass" />{approve.isPending ? "Approving…" : "Approve & Deliver"}</Button>}
                title="Approve and deliver order?"
                description="Stock will be delivered to the customer and the order marked as delivered."
                confirmLabel="Approve"
                variant="default"
                onConfirm={() => approve.mutate()}
              />
            )}

            {canReject && (
              <div className="flex gap-2 items-start">
                <Input
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  placeholder="Rejection reason (required)"
                  className="w-64"
                />
                <ConfirmDialog
                  trigger={<Button variant="destructive" disabled={reject.isPending}><X className="h-4 w-4 text-rust" />{reject.isPending ? "Rejecting…" : "Reject"}</Button>}
                  title="Reject this order?"
                  description={rejectReason.trim() ? `Reason: ${rejectReason}` : "A reason is required to reject."}
                  confirmLabel="Reject"
                  onConfirm={() => {
                    if (!rejectReason.trim()) { setActionError("Rejection reason is required."); return; }
                    reject.mutate();
                  }}
                />
              </div>
            )}

            {canCredit && (
              <ConfirmDialog
                trigger={<Button variant="outline" disabled={creditBalance.isPending}><CircleDollarSign className="h-4 w-4" />{creditBalance.isPending ? "Processing…" : "Credit to Balance"}</Button>}
                title="Credit to wallet balance?"
                description="The paid amount will be credited to the buyer's wallet balance."
                confirmLabel="Credit"
                variant="default"
                onConfirm={() => creditBalance.mutate()}
              />
            )}

            {canFulfill && (
              <div className="flex w-full flex-col items-start gap-2">
                <Textarea
                  value={fulfillContent}
                  onChange={e => setFulfillContent(e.target.value)}
                  placeholder="Account/content to send to the buyer (required)"
                  className="w-full sm:w-96"
                  rows={4}
                />
                <ConfirmDialog
                  trigger={<Button disabled={fulfill.isPending}><Send className="h-4 w-4" />{fulfill.isPending ? "Sending…" : "Send to Buyer"}</Button>}
                  title="Send this delivery content to the buyer?"
                  description="The buyer will be notified with the content below, and the order will be marked delivered."
                  confirmLabel="Send"
                  variant="default"
                  onConfirm={() => {
                    if (!fulfillContent.trim()) { setActionError("Delivery content is required."); return; }
                    fulfill.mutate();
                  }}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </PageLayout>
  );
}
