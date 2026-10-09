import { getCustomerFacingReference, type CustomerProgress } from "@app/core/orderFulfillment";
import { t } from "@app/core/i18n";
import { escape } from "./templates";

/** Phases whose Telegram status carries the bot's Support button; their text
 * ends with a hint pointing at it. Bot-only: the web renders the shared body
 * keys without this hint. */
export const SUPPORT_PHASES: ReadonlySet<string> = new Set(["UNDERPAID", "REVIEW", "FAILED", "CANCELLED"]);

/** The one definition of which Telegram statuses carry the Support button:
 * the support phases, and a stock delivery whose credentials file has been
 * "sending" for too long (its slow line itself points at the button). */
export function supportButtonFor(phase: string, slow: boolean): boolean {
  return SUPPORT_PHASES.has(phase) || (phase === "DELIVERING" && slow);
}

/** The static line a phase shows once it has been slow for too long. */
function slowLineKey(phase: string): string {
  return phase === "DELIVERING" ? "transaction.premium_delivering_slow" : "order.progress_detected_slow";
}

/** Pure Telegram presentation. Financial figures are supplied by the domain. */
export function renderTransactionStatusMessage(input: {
  orderCode: string;
  presentation: CustomerProgress;
  lang: string;
  frame: string;
  summary?: string;
  /** Already-escaped receipt lines (game ID, zone/server, SN) shown under the items. */
  details?: string[];
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
    ...(input.details?.length ? ["", ...input.details] : []),
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
  lines.push("", escape(t(input.slow ? slowLineKey(p.phase) : p.bodyKey, lang)));
  if (SUPPORT_PHASES.has(p.phase)) lines.push(escape(t("transaction.support_hint", lang)));
  return lines.join("\n");
}
