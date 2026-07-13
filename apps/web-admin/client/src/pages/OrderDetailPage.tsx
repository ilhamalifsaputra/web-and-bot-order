import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

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
  currency: string;
  totalAmount: string;
  createdAt: string;
  createdAtDisplay: string | null;
  user: { id: number; fullName: string | null; username: string | null; telegramId: string | null } | null;
  items: OrderItem[];
  voucher: { code: string; type: string } | null;
  /** Set only by a manual/manual_with_info fulfilment (fulfillManualOrder) —
   * always null for auto-delivered orders, which deliver via stockItem
   * instead. The admin's own audit view of what was sent to the buyer. */
  deliveredContent: string | null;
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
}

function useOrderDetail(orderId: string) {
  return useQuery<OrderDetailData>({
    queryKey: ["order", orderId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${orderId}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<OrderDetailData>;
    },
    enabled: !!orderId,
  });
}

export function OrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isError } = useOrderDetail(orderId ?? "");
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
  const canResend = isDelivered && order.user?.telegramId != null;
  const hasCustomerData = customerDataFields.length > 0 && customerData.length > 0;
  // Manual/manual_with_info orders never reserve stock (stockItemId stays
  // null for every unit, from checkout through fulfilment) — unlike auto
  // orders, which reserve a stockItem immediately at checkout, well before
  // delivery. A row-of-dashes Credentials column on a manual order is just
  // noise, so hide it there; a real auto order keeps the column exactly as
  // before.
  const isManualOrder = order.items.length > 0 && order.items.every(i => i.stockItem === null);

  return (
    <PageLayout title={`Order ${order.orderCode}`}>
      <PageHeader
        title={`Order ${order.orderCode}`}
        breadcrumb={[{ label: "Orders", href: "/orders" }]}
        actions={<Button variant="outline" size="sm" onClick={() => navigate("/orders")}>← Back</Button>}
      />

      {actionError && <p className="mb-4 text-sm text-rust">{actionError}</p>}

      {/* Order info */}
      <div className="grid grid-cols-1 gap-4 mb-6 sm:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Order Info</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between">
              <span className="text-ink-soft">Status</span>
              <StatusBadge status={order.status} />
            </div>
            <div className="flex justify-between">
              <span className="text-ink-soft">Customer</span>
              <span className="text-ink">{order.user?.fullName ?? order.user?.username ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-soft">Telegram ID</span>
              <span className="font-mono text-xs text-ink-soft">{order.user?.telegramId ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-soft">Date</span>
              <span className="text-ink">{order.createdAtDisplay ?? "—"}</span>
            </div>
            {order.voucher && (
              <div className="flex justify-between">
                <span className="text-ink-soft">Voucher</span>
                <span className="font-mono text-xs">{order.voucher.code} ({order.voucher.type})</span>
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

      {/* Items table */}
      <h2 className="text-sm font-semibold text-ink mb-3">Items ({order.items.length})</h2>
      <DataTable
        columns={[
          { key: "product", header: "Product", render: item => <span className="text-sm">{item.product.name}</span> },
          { key: "qty", header: "Qty", render: item => <span className="text-sm text-center">{item.quantity}</span> },
          { key: "price", header: "Unit Price", render: item => <span className="text-sm font-mono">{item.unitPrice}</span> },
          ...(isManualOrder
            ? []
            : [{ key: "credentials", header: "Credentials", render: (item: OrderItem) => <span className="font-mono text-xs text-ink-soft">{item.stockItem?.credentials ?? "—"}</span> }]),
        ]}
        data={order.items}
        keyExtractor={item => item.id}
        empty={<EmptyState title="No items" />}
      />

      {/* Buyer-submitted custom checkout info (manual_with_info orders only) */}
      {hasCustomerData && (
        <Card className="mt-6">
          <CardHeader><CardTitle>Buyer-Submitted Info</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {customerData.map((unit, i) => (
              <div key={i} className="flex flex-col gap-1">
                {customerDataFields.map(field => (
                  <div key={field.key} className="flex justify-between gap-4">
                    <span className="text-ink-soft">
                      {customerData.length > 1 ? `Unit ${i + 1} — ${field.label.en}` : field.label.en}
                    </span>
                    <span className="text-ink text-right">{unit[field.key] || "—"}</span>
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
                trigger={<Button variant="outline" disabled={resend.isPending}>{resend.isPending ? "Resending…" : "Resend to Telegram"}</Button>}
                title="Resend credentials to the buyer?"
                description="Queues a fresh account-credentials message to the buyer's Telegram — use this if they say they never received it."
                confirmLabel="Resend"
                variant="default"
                onConfirm={() => resend.mutate()}
              />
            )}

            {canAct && (
              <ConfirmDialog
                trigger={<Button disabled={approve.isPending}>{approve.isPending ? "Approving…" : "Approve & Deliver"}</Button>}
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
                  trigger={<Button variant="destructive" disabled={reject.isPending}>{reject.isPending ? "Rejecting…" : "Reject"}</Button>}
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
                trigger={<Button variant="outline" disabled={creditBalance.isPending}>{creditBalance.isPending ? "Processing…" : "Credit to Balance"}</Button>}
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
                  trigger={<Button disabled={fulfill.isPending}>{fulfill.isPending ? "Sending…" : "Send to Buyer"}</Button>}
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
