import { getCustomerFacingReference, type CustomerProgress } from "@app/core/orderFulfillment";
import { t } from "@app/core/i18n";
import { escape } from "./templates";

/** Pure Telegram presentation. Financial figures are supplied by the domain. */
export function renderTransactionStatusMessage(input: {
  orderCode: string;
  presentation: CustomerProgress;
  lang: string;
  frame: string;
  summary?: string;
  amount: string;
  balance?: string;
  underpayment?: { required: string; received: string | null } | null;
  slow?: boolean;
}): string {
  const { presentation: p, lang } = input;
  const active = p.spinner && !input.slow;
  const icon = active ? input.frame : ["SUCCESS", "WALLET_CREDITED"].includes(p.phase) ? "✅" : ["REVIEW", "UNDERPAID", "FAILED"].includes(p.phase) ? "⚠️" : p.phase === "NONE" ? "💳" : "🕒";
  const wallet = p.transactionType === "WALLET_TOPUP";
  const reference = `<code>${escape(getCustomerFacingReference(input))}</code>`;
  const lines = [
    `${icon} <b>${escape(t(p.titleKey, lang))}</b>`, "",
    ...(wallet ? [escape(t("transaction.wallet", lang)), `${escape(t("transaction.receipt", lang))}: ${reference}`] : [`${escape(t("transaction.order", lang))} ${reference}`]),
    ...(input.summary ? ["", input.summary] : []),
    "", `${escape(t("transaction.amount", lang))}: ${escape(input.amount)}`,
    ...(input.balance ? [`${escape(t("transaction.balance", lang))}: ${escape(input.balance)}`] : []),
  ];
  if (input.underpayment) lines.push(
    `${escape(t("transaction.required", lang))}: ${escape(input.underpayment.required)}`,
    `${escape(t("transaction.received", lang))}: ${escape(input.underpayment.received ?? t("transaction.received_unknown", lang))}`,
  );
  if (p.progress !== null && !input.slow) {
    const cells = Math.round(p.progress / 10);
    lines.push("", `${"█".repeat(cells)}${"░".repeat(10 - cells)} ${p.progress}%`);
  }
  lines.push("", escape(t(input.slow ? "order.progress_detected_slow" : p.bodyKey, lang)));
  return lines.join("\n");
}
