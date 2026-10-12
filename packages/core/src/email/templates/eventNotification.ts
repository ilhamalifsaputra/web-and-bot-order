import { EMAIL_EVENT_REGISTRY, type EmailEventKey } from "../registry";
import { renderShell } from "../layout";
import * as components from "../components";
import type { BrandConfig, RenderedEmail } from "../types";

/** Safe factual copy from the binding event matrix. Never render arbitrary payload/secrets. */
export function renderEventNotification(key: EmailEventKey, payload: Record<string, unknown>, brand: BrandConfig): RenderedEmail {
  const definition = EMAIL_EVENT_REGISTRY.find((row) => row.key === key)!;
  const labels: Record<string, string> = {
    order_code: "Order", status: "Status", ticket_id: "Ticket", sku_name: "SKU", available: "Available stock",
    critical: "Critical threshold", recovery: "Recovery threshold", refund_id: "Refund", amount: "Amount", currency: "Currency", payout_method: "Payout method",
    provider: "Provider", failure_count: "Failures in window", window_minutes: "Window (minutes)",
    period_start: "Period start", period_end: "Period end", timezone: "Timezone", completed_count: "Completed product orders",
    revenue: "Gross product revenue", net_revenue: "Net product revenue", refunds: "Recorded refund payouts", inventory_low: "Low stock SKUs", inventory_out: "Out of stock SKUs",
    payment_statuses: "Payment status breakdown", report_definition: "Definition", occurred_at: "Recorded at",
  };
  const rows = Object.entries(labels).flatMap(([field, label]) => {
    const value = payload[field];
    return value == null || typeof value === "object" ? [] : [{ label, value: String(value) }];
  });
  let bodyHtml = components.title(definition.label) + components.subtitle(definition.description) + components.infoTable(rows);
  let text = `${brand.shopName}\n\n${definition.label}\n${definition.description}\n\n` + rows.map((row) => `${row.label}: ${row.value}`).join("\n");
  const target = key === "account.password_reset.requested" ? payload.reset_url : payload.order_url ?? payload.ticket_url;
  if (typeof target === "string" && /^https?:\/\//.test(target)) {
    bodyHtml += components.primaryButton(key === "account.password_reset.requested" ? "Reset password" : "View details", target, brand.accentColor);
    text += `\n\n${key === "account.password_reset.requested" ? "Reset password" : "View details"}: ${target}`;
  }
  if (key === "account.password_reset.requested") {
    const expiry = `This link expires after ${String(payload.expiry_minutes ?? 60)} minutes and can be used once.`;
    bodyHtml += components.subtitle(expiry); text += `\n${expiry}`;
  }
  return { subject: definition.label, text, html: renderShell({ brand, bodyHtml, preheader: definition.description }) };
}
