import type { BrandConfig, RenderedEmail } from "../types";
import type { EmailEventKey } from "../registry";
import { renderEventNotification } from "./eventNotification";
import { renderOrderReadyEmail } from "./orderReady";
import { renderResetPasswordEmail, PASSWORD_RESET_EMAIL_COPY } from "./resetPassword";

/** Render-only fixtures: no customer/order lookup, recovery token, outbox write or transport. */
export function renderEmailEventPreview(key: EmailEventKey, brand: BrandConfig): RenderedEmail {
  if (key === "account.password_reset.requested") return renderResetPasswordEmail({
    resetUrl: "https://example.invalid/preview/reset", expiryMinutes: 60, requestedAt: "2026-01-01 00:00 UTC", ip: null, userAgent: "Preview device",
  }, brand, PASSWORD_RESET_EMAIL_COPY);
  if (key === "order.completed.customer") return renderOrderReadyEmail({
    orderCode: "PREVIEW-ORDER", items: [{ name: "Example product", variant: null, quantity: 1, unitPrice: "Rp10.000", lineTotal: "Rp10.000" }],
    subtotal: "Rp10.000", discount: "", uniqueCode: "", total: "Rp10.000", warranty: null,
    orderUrl: "https://example.invalid/preview/order", trackUrl: null,
  }, brand);
  let facts: Record<string, unknown> = {};
  if (key.startsWith("order.") || key.startsWith("payment.")) facts = { order_code: "PREVIEW-ORDER", status: "Example status" };
  if (key.startsWith("inventory.")) facts = { sku_name: "Example SKU", available: key.endsWith("out_of_stock") ? 0 : key.endsWith("restocked") ? 4 : 2, critical: 3, recovery: 4 };
  if (key.startsWith("refund.")) facts = { refund_id: "PREVIEW-REFUND", amount: "10000", currency: "IDR" };
  if (key.startsWith("support.")) facts = { ticket_id: "PREVIEW-TICKET" };
  if (key.startsWith("provider.")) facts = { provider: "Example provider", failure_count: 3, window_minutes: 10 };
  if (key.startsWith("report.")) facts = {
    period_start: "2026-01-01T00:00:00Z", period_end: "2026-01-02T00:00:00Z", timezone: "UTC", completed_count: 1,
    revenue: "10000 IDR; 0 USDT", net_revenue: "10000 IDR; 0 USDT", refunds: "0 IDR; 0 USDT", inventory_low: 1, inventory_out: 0,
  };
  return renderEventNotification(key, { ...facts, occurred_at: "2026-01-01T00:00:00Z" }, brand);
}
