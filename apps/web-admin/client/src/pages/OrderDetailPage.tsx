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
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { apiPost } from "../api/client";

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
  user: { id: number; fullName: string | null; username: string | null; telegramId: string } | null;
  items: OrderItem[];
  voucher: { code: string; type: string } | null;
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

interface OrderDetailData {
  order: OrderDetail;
  money: MoneyView;
  isDelivered: boolean;
  canAct: boolean;
  canCredit: boolean;
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
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["order", orderId] });

  const approve = useMutation({
    mutationFn: () => apiPost(`/api/orders/${orderId}/approve`, {}),
    onSuccess: () => { refresh(); setActionError(null); },
    onError: (e: Error) => setActionError(e.message),
  });

  const reject = useMutation({
    mutationFn: () => apiPost(`/api/orders/${orderId}/reject`, { reason: rejectReason }),
    onSuccess: () => { refresh(); setRejectReason(""); setActionError(null); },
    onError: (e: Error) => setActionError(e.message),
  });

  const creditBalance = useMutation({
    mutationFn: () => apiPost(`/api/orders/${orderId}/credit-balance`, {}),
    onSuccess: () => { refresh(); setActionError(null); },
    onError: (e: Error) => setActionError(e.message),
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

  const { order, money, canAct, canCredit } = data;

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
              <span className="text-ink">{new Date(order.createdAt).toLocaleString()}</span>
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
          { key: "credentials", header: "Credentials", render: item => <span className="font-mono text-xs text-ink-soft">{item.stockItem?.credentials ?? "—"}</span> },
        ]}
        data={order.items}
        keyExtractor={item => item.id}
        empty={<EmptyState title="No items" />}
      />

      {/* Actions */}
      {(canAct || canCredit) && (
        <Card className="mt-6">
          <CardHeader><CardTitle>Actions</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-3">
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

            {canAct && (
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
          </CardContent>
        </Card>
      )}
    </PageLayout>
  );
}
