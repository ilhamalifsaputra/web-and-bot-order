import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
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
        <p style={{ color: "red" }}>Failed to load order.</p>
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
      <button
        onClick={() => navigate("/orders")}
        style={{
          marginBottom: 16,
          background: "none",
          border: "1px solid #ccc",
          borderRadius: 4,
          padding: "4px 12px",
          cursor: "pointer",
        }}
      >
        ← Back to Orders
      </button>

      {actionError && (
        <p style={{ color: "red", marginBottom: 12 }}>{actionError}</p>
      )}

      <section style={{ marginBottom: 20 }}>
        <p>
          <strong>Status:</strong> {order.status}
        </p>
        <p>
          <strong>Customer:</strong>{" "}
          {order.user?.fullName ?? order.user?.username ?? "—"}{" "}
          {order.user ? `(TG: ${order.user.telegramId})` : ""}
        </p>
        <p>
          <strong>Date:</strong> {new Date(order.createdAt).toLocaleString()}
        </p>
        {order.voucher && (
          <p>
            <strong>Voucher:</strong> {order.voucher.code} ({order.voucher.type})
          </p>
        )}
      </section>

      <section style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Payment</h2>
        <p>Items: {money.itemsTotal} {money.currency}</p>
        {money.bulkDiscount && <p>Bulk discount: −{money.bulkDiscount}</p>}
        {money.discount && <p>Discount: −{money.discount}</p>}
        {money.walletCredit && <p>Wallet credit: −{money.walletCredit}</p>}
        {money.amountMarker && <p>Unique cents: +{money.amountMarker}</p>}
        <p>
          <strong>Total: {money.totalToPay} {money.currency}</strong>
        </p>
        {money.equivalentIdr && <p>≈ {money.equivalentIdr} IDR</p>}
      </section>

      <section style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Items ({order.items.length})</h2>
        {order.items.length === 0 ? (
          <p>No items.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f5f5f5" }}>
                <th style={{ textAlign: "left", padding: "5px 8px" }}>Product</th>
                <th style={{ textAlign: "center", padding: "5px 8px" }}>Qty</th>
                <th style={{ textAlign: "right", padding: "5px 8px" }}>Unit Price</th>
                <th style={{ textAlign: "left", padding: "5px 8px" }}>Credentials</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id} style={{ borderTop: "1px solid #eee" }}>
                  <td style={{ padding: "5px 8px" }}>{item.product.name}</td>
                  <td style={{ padding: "5px 8px", textAlign: "center" }}>{item.quantity}</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>{item.unitPrice}</td>
                  <td style={{ padding: "5px 8px", fontFamily: "monospace", fontSize: 12 }}>
                    {item.stockItem?.credentials ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {(canAct || canCredit) && (
        <section style={{ background: "#f9f9f9", padding: 16, borderRadius: 6 }}>
          <h2 style={{ fontSize: 15, marginBottom: 12 }}>Actions</h2>

          {canAct && (
            <div style={{ marginBottom: 12 }}>
              <button
                onClick={() => {
                  if (confirm("Approve and deliver this order?")) approve.mutate();
                }}
                disabled={approve.isPending}
                style={{
                  padding: "6px 16px",
                  background: "#28a745",
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  marginRight: 8,
                }}
              >
                {approve.isPending ? "Approving…" : "Approve & Deliver"}
              </button>
            </div>
          )}

          {canAct && (
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Rejection reason (required)"
                style={{ flex: 1, padding: "5px 8px" }}
              />
              <button
                onClick={() => {
                  if (!rejectReason.trim()) {
                    setActionError("Rejection reason is required.");
                    return;
                  }
                  if (confirm("Reject this order?")) reject.mutate();
                }}
                disabled={reject.isPending}
                style={{
                  padding: "5px 14px",
                  background: "#dc3545",
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                {reject.isPending ? "Rejecting…" : "Reject"}
              </button>
            </div>
          )}

          {canCredit && (
            <button
              onClick={() => {
                if (confirm("Credit the paid amount to the buyer's balance?"))
                  creditBalance.mutate();
              }}
              disabled={creditBalance.isPending}
              style={{
                padding: "6px 16px",
                background: "#6c757d",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              {creditBalance.isPending ? "Processing…" : "Credit to Balance"}
            </button>
          )}
        </section>
      )}
    </PageLayout>
  );
}
